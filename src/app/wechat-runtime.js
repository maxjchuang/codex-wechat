const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { SessionStore } = require("../infra/storage/session-store");
const { MessageStore } = require("../infra/storage/message-store");
const { MessageDelivery } = require("./message-delivery");
const { TaskManager } = require("./task-manager");
const { TaskReports } = require("./task-reports");
const { TaskWatches } = require("./task-watches");
const { TaskManagerModel } = require("../infra/model/task-manager-model");
const { createLocalManagerRunner } = require("../infra/model/local-manager-model");
const { CodexRpcClient } = require("../infra/codex/rpc-client");
const codexMessageUtils = require("../infra/codex/message-utils");
const { getUpdates, sendMessage, getConfig, sendTyping } = require("../infra/weixin/api");
const { persistIncomingWeixinAttachments } = require("../infra/weixin/media-receive");
const { getMimeFromFilename } = require("../infra/weixin/media-mime");
const { sendWeixinMediaFile } = require("../infra/weixin/media-send");
const { redactSensitiveText } = require("../infra/weixin/redact");
const { resolveSelectedAccount } = require("../infra/weixin/account-store");
const {
  loadPersistedContextTokens,
  persistContextToken,
} = require("../infra/weixin/context-token-store");
const { loadSyncBuffer } = require("../infra/weixin/sync-buffer-store");
const {
  chunkReplyText,
  markdownToPlainText,
  normalizeWeixinIncomingMessage,
} = require("../infra/weixin/message-utils");
const {
  extractBindPath,
  extractCommandArgument,
  extractEffortValue,
  extractModelValue,
  extractRemoveWorkspacePath,
  extractSendPath,
  extractSwitchThreadId,
} = require("../shared/command-parsing");
const {
  filterThreadsByWorkspaceRoot,
  isAbsoluteWorkspacePath,
  isWorkspaceAllowed,
  normalizeWorkspacePath,
  pathMatchesWorkspaceRoot,
} = require("../shared/workspace-paths");
const {
  extractModelCatalogFromListResponse,
  findModelByQuery,
  resolveEffectiveModelForEffort,
} = require("../shared/model-catalog");
const { formatFailureText } = require("../shared/error-text");

const SESSION_EXPIRED_ERRCODE = -14;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const TYPING_KEEPALIVE_MS = 5_000;
const SESSION_PAGE_SIZE = 10;
const MANAGED_SESSION_SOURCES = ["cli", "vscode", "exec", "appServer", "unknown"];
const THREAD_SOURCE_KINDS = new Set([
  "app",
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]);

class SessionManagerError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

class WechatRuntime {
  constructor(config) {
    this.config = config;
    this.sessionStore = new SessionStore({ filePath: config.sessionsFile });
    this.account = null;
    this.messageStore = null;
    this.taskReports = null;
    this.taskWatches = null;
    this.delivery = null;
    this.connectingCodex = false;
    this.lastPollAt = 0;
    this.submittingThreads = new Set();
    this.managerWorkspace = path.join(path.dirname(config.sessionsFile), "manager-workspace");
    const runLocal = config.agentManager ? createLocalManagerRunner({
      command: config.codexCommand, model: config.managerModel, workspace: this.managerWorkspace,
    }) : undefined;
    this.taskManager = new TaskManager(this, new TaskManagerModel({ apiKey: config.modelApiKey, model: config.managerModel, runLocal }));
    this.codex = new CodexRpcClient({
      endpoint: config.codexEndpoint,
      env: { ...process.env, CODEX_WECHAT_MODEL_API_KEY: undefined },
      codexCommand: config.codexCommand,
    });
    this.contextTokenByUserId = new Map();
    this.pendingChatContextByThreadId = new Map();
    this.activeTurnIdByThreadId = new Map();
    this.pendingApprovalByThreadId = new Map();
    this.currentRunKeyByThreadId = new Map();
    this.replyBufferByRunKey = new Map();
    this.typingStopByThreadId = new Map();
    this.bindingKeyByThreadId = new Map();
    this.workspaceRootByThreadId = new Map();
    this.approvalAllowlistByWorkspaceRoot = new Map();
    this.resumedThreadIds = new Set();
    this.inFlightApprovalRequestKeys = new Set();
    this.codex.onMessage((message) => {
      this.handleCodexMessage(message).catch((error) => {
        console.error(`[codex-wechat] failed to handle Codex message: ${error.message}`);
      });
    });
    this.codex.onDisconnect(() => this.handleCodexDisconnect());
  }

  async start() {
    this.account = resolveSelectedAccount(this.config);
    this.validateConfig();
    this.restorePersistedContextTokens();
    const deliveriesFile = this.config.deliveriesFile || path.join(path.dirname(this.config.sessionsFile), "deliveries.sqlite");
    this.messageStore = new MessageStore(deliveriesFile, this.account.accountId);
    this.recoverInterruptedMessages();
    this.delivery = new MessageDelivery({
      store: this.messageStore,
      receive: (message, id) => this.handleIncomingMessage(message, id),
      send: (message) => this.sendWeixinText(message),
      reportError: (error) => console.error(`[codex-wechat] delivery: ${error.message}`),
    });
    this.taskReports = new TaskReports({
      store: this.messageStore,
      codex: this.codex,
      getModel: () => this.taskManager.model,
      canReport: (sender) => this.config.allowedUserIds?.includes(sender),
      buildReply: (sender, text, token) => this.buildTextReply(sender, text, this.contextTokenByUserId.get(sender) || token),
      reportError: (error) => console.warn(`[codex-wechat] task report: ${error.message}`),
    });
    this.taskReports.start();
    this.taskWatches = new TaskWatches({
      store: this.messageStore,
      codex: this.codex,
      buildReply: (sender, text, token) => this.buildTextReply(sender, text, this.contextTokenByUserId.get(sender) || token),
      canWatch: async (senderId, id, cwd) => this.config.allowedUserIds?.includes(senderId)
        && !this.isManagerThread({ id, cwd }) && isManagedWorkspaceAllowed(cwd, await this.getSessionManagerRoots({ senderId })),
      reportError: (error) => console.warn(`[codex-wechat] task watch: ${error.message}`),
    });
    this.taskWatches.start();
    this.delivery.start();
    void this.connectCodex();
    const reconnectTimer = setInterval(() => { void this.connectCodex(); }, 3_000);
    console.log(`[codex-wechat] runtime ready; manager=${this.config.agentManager ? "agent" : "rules"}; WeChat polling and Codex connect independently`);
    try {
      await this.monitorLoop();
    } finally {
      clearInterval(reconnectTimer);
      this.delivery.stop();
      this.taskReports.stop();
      this.taskWatches.stop();
      this.codex.close();
    }
  }

  async connectCodex() {
    if (this.codex.isReady || this.connectingCodex) return;
    this.connectingCodex = true;
    try {
      await this.codex.connect();
      await this.codex.initialize();
      await this.refreshAvailableModelCatalogAtStartup().catch((error) => {
        console.warn(`[codex-wechat] model catalog unavailable: ${error.message}`);
      });
    } catch (error) {
      this.codex.close();
      console.warn(`[codex-wechat] Codex unavailable: ${error.message}`);
    } finally {
      this.connectingCodex = false;
    }
  }

  recoverInterruptedMessages(submittedOnly = false) {
    this.messageStore?.recoverInterrupted((message, entry) => {
      const token = message.context_token || this.contextTokenByUserId.get(message.from_user_id);
      if (!token) return [];
      const text = entry.thread
        ? `会话 ${entry.thread} 的提交或结果待确认。请查看原会话；这条指令不会自动重发。`
        : "上一条请求的处理结果待确认，请先查看当前状态。";
      return buildWeixinTextMessages(message.from_user_id, text, token);
    }, submittedOnly);
  }

  handleCodexDisconnect() {
    this.recoverInterruptedMessages(true);
    this.resumedThreadIds.clear();
    this.pendingChatContextByThreadId.clear();
    this.pendingApprovalByThreadId.clear();
    this.activeTurnIdByThreadId.clear();
    this.currentRunKeyByThreadId.clear();
    this.replyBufferByRunKey.clear();
    for (const threadId of this.typingStopByThreadId.keys()) void this.stopTypingForThread(threadId);
  }

  validateConfig() {
    if (!this.account || !this.account.token) {
      throw new Error("缺少已登录的微信账号，请先执行 `codex-wechat login`");
    }
    const defaultWorkspaceRoot = normalizeWorkspacePath(this.config.defaultWorkspaceRoot);
    if (defaultWorkspaceRoot) {
      if (!isAbsoluteWorkspacePath(defaultWorkspaceRoot)) {
        throw new Error("CODEX_WECHAT_DEFAULT_WORKSPACE 必须是绝对路径");
      }
      if (!isWorkspaceAllowed(defaultWorkspaceRoot, this.config.workspaceAllowlist)) {
        throw new Error("CODEX_WECHAT_DEFAULT_WORKSPACE 不在允许绑定的白名单中");
      }
    }
  }

  restorePersistedContextTokens() {
    const persistedTokens = loadPersistedContextTokens(this.config, this.account.accountId);
    let restoredCount = 0;
    for (const [userId, token] of Object.entries(persistedTokens)) {
      this.contextTokenByUserId.set(userId, token);
      restoredCount += 1;
    }
    if (restoredCount > 0) {
      console.log(`[codex-wechat] restored ${restoredCount} persisted context token(s)`);
    }
  }

  rememberContextToken(userId, contextToken) {
    const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
    const normalizedToken = typeof contextToken === "string" ? contextToken.trim() : "";
    if (!normalizedUserId || !normalizedToken || !this.account?.accountId) {
      return;
    }

    this.contextTokenByUserId.set(normalizedUserId, normalizedToken);
    persistContextToken(this.config, this.account.accountId, normalizedUserId, normalizedToken);
  }

  async refreshAvailableModelCatalogAtStartup() {
    const response = await this.codex.listModels();
    const models = extractModelCatalogFromListResponse(response);
    if (!models.length) {
      console.warn("[codex-wechat] model/list returned no models at startup");
      return;
    }
    this.sessionStore.setAvailableModelCatalog(models);
    this.validateDefaultModelConfig(models);
    console.log(`[codex-wechat] model catalog refreshed: ${models.length} entries`);
  }

  validateDefaultModelConfig(models) {
    if (this.config.defaultCodexModel) {
      const matched = findModelByQuery(models, this.config.defaultCodexModel);
      if (!matched) {
        throw new Error(`Invalid CODEX_WECHAT_DEFAULT_CODEX_MODEL: ${this.config.defaultCodexModel}`);
      }
      if (this.config.defaultCodexEffort) {
        const supported = matched.supportedReasoningEfforts || [];
        if (supported.length && !supported.includes(this.config.defaultCodexEffort)) {
          throw new Error(
            `Invalid CODEX_WECHAT_DEFAULT_CODEX_EFFORT: ${this.config.defaultCodexEffort} for model ${matched.model}`
          );
        }
      }
      return;
    }

    if (this.config.defaultCodexEffort) {
      const effectiveModel = resolveEffectiveModelForEffort(models, "");
      const supported = effectiveModel?.supportedReasoningEfforts || [];
      if (effectiveModel && supported.length && !supported.includes(this.config.defaultCodexEffort)) {
        throw new Error(
          `Invalid CODEX_WECHAT_DEFAULT_CODEX_EFFORT: ${this.config.defaultCodexEffort} for model ${effectiveModel.model}`
        );
      }
    }
  }

  async monitorLoop() {
    let getUpdatesBuf = this.messageStore.getCursor() ?? loadSyncBuffer(this.config, this.account.accountId);
    let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
    let consecutiveFailures = 0;

    while (true) {
      try {
        const response = await getUpdates({
          baseUrl: this.account.baseUrl,
          token: this.account.token,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: nextTimeoutMs,
        });

        if (response.longpolling_timeout_ms > 0) {
          nextTimeoutMs = Math.min(60_000, response.longpolling_timeout_ms);
        }

        const isApiError =
          (response.ret !== undefined && response.ret !== 0)
          || (response.errcode !== undefined && response.errcode !== 0);
        if (isApiError) {
          if (response.errcode === SESSION_EXPIRED_ERRCODE || response.ret === SESSION_EXPIRED_ERRCODE) {
            throw new Error("微信会话已失效，请重新执行 `codex-wechat login`");
          }
          consecutiveFailures += 1;
          console.error(`[codex-wechat] getUpdates failed ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg || ""}`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            consecutiveFailures = 0;
            await sleep(BACKOFF_DELAY_MS);
          } else {
            await sleep(RETRY_DELAY_MS);
          }
          continue;
        }

        consecutiveFailures = 0;
        if (!response.timedOut) this.lastPollAt = Date.now();
        const cursor = typeof response.get_updates_buf === "string" ? response.get_updates_buf : "";
        const messages = Array.isArray(response.msgs) ? response.msgs : [];
        this.messageStore.acceptBatch(cursor, messages, (message) => this.isFastMessage(message));
        getUpdatesBuf = cursor || getUpdatesBuf;
        this.delivery.tick();
      } catch (error) {
        consecutiveFailures += 1;
        console.error(`[codex-wechat] monitor error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${error.message}`);
        if (String(error.message || "").includes("重新执行 `codex-wechat login`")) {
          throw error;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS);
        } else {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
  }

  async handleIncomingMessage(message, inboxId = "") {
    const senderId = typeof message?.from_user_id === "string" ? message.from_user_id.trim() : "";
    const contextToken = typeof message?.context_token === "string" ? message.context_token.trim() : "";
    if (senderId && contextToken) {
      this.rememberContextToken(senderId, contextToken);
    }

    const normalized = normalizeWeixinIncomingMessage(message, this.config, this.account.accountId);
    if (!normalized) {
      return;
    }
    normalized.inboxId = inboxId;

    if (!this.isUserAllowed(normalized.senderId)) {
      await this.sendReplyToUser(normalized.senderId, "当前账号未允许该微信号控制本机 Codex。", normalized.contextToken);
      return;
    }

    try {
      if (await this.taskManager.handle(normalized)) return;
      await this.routeUserMessage(normalized);
    } catch (error) {
      const uncertain = isUncertainSubmission(error);
      if (inboxId) console.warn("[codex-wechat] inbound failed " + JSON.stringify({
        at: new Date().toISOString(), inbox: inboxId, code: error.code || "unclassified", method: error.rpcMethod,
      }));
      await this.sendReplyToUser(
        normalized.senderId,
        uncertain ? (error.rpcMethod === "thread/start"
          ? "Codex 新建结果待确认。请先在 Codex App 查看会话列表，这条请求不会自动重试。"
          : "Codex 提交结果待确认。请查看原会话；这条指令不会自动重发。") : formatFailureText("处理失败", error),
        normalized.contextToken,
        { finishId: inboxId, uncertain }
      );
      if (!inboxId && !(error instanceof SessionManagerError)) {
        throw error;
      }
    }
  }

  async routeUserMessage(normalized, confirmedThreadId, target) {
    const workspaceContext = target ? {
      bindingKey: this.sessionStore.buildBindingKey(normalized), workspaceRoot: normalizeWorkspacePath(target.cwd),
    } : await this.resolveWorkspaceContext(normalized);
    if (!workspaceContext) return;

    const { bindingKey, workspaceRoot } = workspaceContext;
    const explicit = Boolean(target) || this.sessionStore.isExplicitThreadSelection(bindingKey, workspaceRoot);
    const selectedThreadId = target?.id || this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    let ownedElsewhere = false;
    if (confirmedThreadId && (!explicit || confirmedThreadId !== selectedThreadId)) {
      throw new SessionManagerError("当前选中的会话已变化，请重新发送任务。");
    }
    if (explicit) {
      const thread = await this.readSelectedThread(selectedThreadId, workspaceRoot);
      if (target) await this.requireManagedWorkspace(thread.cwd, await this.getSessionManagerRoots(normalized));
      normalized.sessionLabel = thread.name || thread.preview;
      if (thread.status?.type === "notLoaded") {
        ownedElsewhere = Boolean(target && await this.codex.hasDesktopThreadOwner(thread.id));
        if (!ownedElsewhere) {
          if (!confirmedThreadId) {
            await this.taskManager.requestHandoff(normalized, thread, target);
            return;
          }
          try {
            await this.resumeManagedThread(thread);
          } catch (error) {
            if (!/already has an active writer/i.test(error.message)) throw error;
            throw new SessionManagerError("原会话仍由其他客户端持有。请在原客户端处理，或等它释放会话后再移交。");
          }
        }
      } else {
        this.requireIdleSession(thread);
        if (!this.resumedThreadIds.has(thread.id)) await this.resumeManagedThread(thread);
      }
    }

    const prepared = await this.prepareIncomingMessageForCodex(normalized, workspaceRoot);
    if (!prepared) return;
    if (ownedElsewhere) {
      await this.queueForCurrentOwner(prepared, selectedThreadId, workspaceRoot);
      return;
    }
    if (target) {
      await this.submitUserMessage({ id: selectedThreadId, bindingKey, workspaceRoot, normalized: prepared,
        codexParams: this.getCodexParamsForWorkspace(bindingKey, workspaceRoot) });
      return;
    }
    const threadId = explicit ? selectedThreadId : (await this.resolveWorkspaceThreadState({
      bindingKey, workspaceRoot, normalized: prepared, autoSelectThread: true,
    })).threadId;

    await this.ensureThreadAndSendMessage({ bindingKey, workspaceRoot, normalized: prepared, threadId, explicit });
  }

  async queueForCurrentOwner(message, threadId, workspaceRoot) {
    if (message.inboxId) this.messageStore.waitForResult(message.inboxId, threadId);
    const title = message.sessionLabel || path.basename(workspaceRoot);
    const report = this.registerTaskReport(message, threadId, title);
    let receipt;
    try {
      receipt = await this.codex.enqueueExistingThread(threadId, report?.text || message.text);
    } catch (error) {
      if (report && !isUncertainSubmission(error)) this.messageStore.removeTaskReport(report.id);
      throw error;
    }
    const task = message.taskLabel ? `\n任务：${message.taskLabel}` : "";
    console.log(`[codex-wechat] native queue accepted ${receipt} for ${threadId}`);
    try {
      await this.sendReplyToUser(message.senderId,
        `已排入「${title}」的原生队列，等待原会话接收。${task}`, message.contextToken, { finishId: message.inboxId });
    } catch (error) {
      throw Object.assign(error, { code: "CODEX_QUEUE_UNCERTAIN" });
    }
  }

  registerTaskReport(message, threadId, title) {
    return message.inboxId && message.taskLabel && this.taskReports
      ? this.taskReports.register(message, threadId, title) : null;
  }

  isFastMessage(message) {
    const normalized = normalizeWeixinIncomingMessage(message, this.config, this.account.accountId);
    return Boolean(normalized && getLocalCommand(normalized));
  }

  async handleLocalCommand(normalized) {
    const command = getLocalCommand(normalized);
    if (command === "help") {
      await this.handleHelpCommand(normalized);
      return true;
    }
    if (command === "bridge_status") {
      const checked = this.lastPollAt ? new Date(this.lastPollAt).toLocaleTimeString() : "等待首次轮询";
      const codex = !this.codex.isReady ? "暂不可用"
        : (this.codex.lastRpcTimeoutAt > this.codex.lastRpcResponseAt ? "有请求超时" : "已连接");
      await this.sendReplyToNormalized(normalized, `微信桥接在线。Codex ${codex}。\n最近微信轮询: ${checked}`);
      return true;
    }
    return false;
  }

  isUserAllowed(senderId) {
    if (!Array.isArray(this.config.allowedUserIds) || !this.config.allowedUserIds.length) {
      return true;
    }
    return this.config.allowedUserIds.includes(senderId);
  }

  async dispatchTextCommand(normalized) {
    switch (normalized.command) {
      case "bind":
        await this.handleBindCommand(normalized);
        return true;
      case "where":
        await this.handleWhereCommand(normalized);
        return true;
      case "workspace":
        await this.handleWorkspaceCommand(normalized);
        return true;
      case "sessions":
        await this.handleSessionsCommand(normalized);
        return true;
      case "use":
        await this.handleUseSessionCommand(normalized);
        return true;
      case "new":
        await this.handleNewCommand(normalized);
        return true;
      case "switch":
        await this.handleSwitchCommand(normalized);
        return true;
      case "inspect_message":
        await this.handleMessageCommand(normalized);
        return true;
      case "stop":
        await this.handleStopCommand(normalized);
        return true;
      case "model":
        await this.handleModelCommand(normalized);
        return true;
      case "effort":
        await this.handleEffortCommand(normalized);
        return true;
      case "approve":
      case "reject":
        await this.handleApprovalCommand(normalized);
        return true;
      case "remove":
        await this.handleRemoveCommand(normalized);
        return true;
      case "send":
        await this.handleSendCommand(normalized);
        return true;
      case "help":
        await this.handleHelpCommand(normalized);
        return true;
      case "unknown_command":
        await this.sendReplyToNormalized(normalized, `未知命令。\n\n${this.buildHelpText()}`);
        return true;
      default:
        return false;
    }
  }

  async handleBindCommand(normalized) {
    const rawWorkspaceRoot = extractBindPath(normalized.text);
    if (!rawWorkspaceRoot) {
      await this.sendReplyToNormalized(normalized, "用法: `/codex bind /绝对路径`");
      return;
    }

    const workspaceRoot = normalizeWorkspacePath(rawWorkspaceRoot);
    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.sendReplyToNormalized(normalized, "只支持绝对路径绑定。");
      return;
    }
    if (!isWorkspaceAllowed(workspaceRoot, this.config.workspaceAllowlist)) {
      await this.sendReplyToNormalized(normalized, "该项目不在允许绑定的白名单中。");
      return;
    }

    const workspaceStats = await this.resolveWorkspaceStats(workspaceRoot);
    if (!workspaceStats.exists) {
      await this.sendReplyToNormalized(normalized, `项目不存在: ${workspaceRoot}`);
      return;
    }
    if (!workspaceStats.isDirectory) {
      await this.sendReplyToNormalized(normalized, `路径非法: ${workspaceRoot}`);
      return;
    }

    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    this.applyDefaultCodexParamsOnBind(bindingKey, workspaceRoot);
    this.sessionStore.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const threadId = this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const text = threadId
      ? `已切换到项目，并恢复原线程。\n\nworkspace: ${workspaceRoot}\nthread: ${threadId}`
      : `已绑定项目。\n\nworkspace: ${workspaceRoot}`;
    await this.sendReplyToNormalized(normalized, text);
  }

  async handleWhereCommand(normalized) {
    const workspaceContext = await this.resolveWorkspaceContext(normalized, false);
    if (!workspaceContext) {
      await this.sendReplyToNormalized(
        normalized,
        this.config.defaultWorkspaceRoot
          ? `默认项目可用，但当前会话尚未持久化绑定。\n\nworkspace: ${normalizeWorkspacePath(this.config.defaultWorkspaceRoot)}`
          : "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。"
      );
      return;
    }

    const { bindingKey, workspaceRoot } = workspaceContext;
    const hasPendingNewThread = this.sessionStore.hasPendingNewThreadForWorkspace(bindingKey, workspaceRoot);
    const { threads, threadId } = await this.resolveWorkspaceThreadState({
      bindingKey,
      workspaceRoot,
      normalized,
      autoSelectThread: true,
    });
    const codexParams = this.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    const statusLabel = this.sessionStore.isExplicitThreadSelection(bindingKey, workspaceRoot)
      ? await this.sessionStatusLabel(await this.readSelectedThread(threadId, workspaceRoot))
      : this.describeWorkspaceStatus(threadId).label;
    await this.sendReplyToNormalized(normalized, [
      `workspace: ${workspaceRoot}`,
      `thread: ${hasPendingNewThread ? "(new draft)" : (threadId || "(none)")}`,
      `status: ${statusLabel}`,
      `model: ${codexParams.model || "(default)"}`,
      `effort: ${codexParams.effort || "(default)"}`,
      `threads: ${threads.length}`,
    ].join("\n"));
  }

  async handleWorkspaceCommand(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoots = this.sessionStore.listWorkspaceRoots(bindingKey);
    if (!workspaceRoots.length) {
      if (this.config.defaultWorkspaceRoot) {
        await this.sendReplyToNormalized(
          normalized,
          `当前没有显式绑定项目。\n默认项目: ${normalizeWorkspacePath(this.config.defaultWorkspaceRoot)}`
        );
        return;
      }
      await this.sendReplyToNormalized(normalized, "当前会话还没有绑定任何项目。");
      return;
    }

    const activeWorkspaceRoot = this.sessionStore.getActiveWorkspaceRoot(bindingKey);
    const lines = workspaceRoots.map((workspaceRoot) => {
      const threadId = this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      const hasPendingNewThread = this.sessionStore.hasPendingNewThreadForWorkspace(bindingKey, workspaceRoot);
      const prefix = workspaceRoot === activeWorkspaceRoot ? "* " : "- ";
      const threadText = hasPendingNewThread
        ? "\n  thread: (new draft)"
        : (threadId ? `\n  thread: ${threadId}` : "");
      return `${prefix}${workspaceRoot}${threadText}`;
    });
    await this.sendReplyToNormalized(normalized, lines.join("\n"));
  }

  async handleSessionsCommand(normalized) {
    const argument = extractCommandArgument(normalized.text, "/codex sessions ");
    const page = argument ? Number(argument) : 1;
    if ((argument && !/^\d+$/.test(argument)) || !Number.isSafeInteger(page * SESSION_PAGE_SIZE) || page < 1) {
      await this.sendReplyToNormalized(normalized, "用法: `/codex sessions [页码]`");
      return;
    }

    const allowedRoots = await this.getSessionManagerRoots(normalized);
    let skip = (page - 1) * SESSION_PAGE_SIZE;
    const sessions = [];
    for await (const thread of this.listManagedSessions(allowedRoots)) {
      if (skip > 0) {
        skip -= 1;
        continue;
      }
      sessions.push(thread);
      if (sessions.length > SESSION_PAGE_SIZE) break;
    }

    if (!sessions.length) {
      this.taskManager.rememberChoices(normalized, []);
      await this.sendReplyToNormalized(normalized, "这一页没有可选的 Codex 会话。");
      return;
    }

    const lines = [`最近会话 · 第 ${page} 页`, ""];
    const choices = sessions.slice(0, SESSION_PAGE_SIZE);
    const nextPage = sessions.length > SESSION_PAGE_SIZE ? page + 1 : null;
    this.taskManager.rememberChoices(normalized, choices, { type: "select", nextPage });
    const formatTime = new Intl.DateTimeFormat(undefined, {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    const statusLabels = await Promise.all(choices.map((thread) => this.sessionStatusLabel(thread)));
    for (const [index, thread] of choices.entries()) {
      const title = (thread.title || "未命名会话").replace(/\s+/g, " ").slice(0, 80);
      const updatedAt = thread.updatedAt > 0 ? formatTime.format(new Date(thread.updatedAt * 1000)) : "";
      lines.push([`${index + 1}. ${title}`, updatedAt, statusLabels[index]].filter(Boolean).join(" · "));
    }
    lines.push("", nextPage ? "回复「第一条」选中，或回复「下一页」。" : "回复编号选中，例如「第一条」。");
    await this.sendReplyToNormalized(normalized, lines.join("\n"));
  }

  async handleUseSessionCommand(normalized) {
    const argument = extractCommandArgument(normalized.text, "/codex use ");
    const match = /^(\S+?)(?:\s+(--confirm-idle))?$/i.exec(argument);
    if (!match || match[1].startsWith("-")) {
      await this.sendReplyToNormalized(normalized, "用法: `/codex use <会话ID> [--confirm-idle]`");
      return;
    }

    const [, threadId, confirmedIdle] = match;
    const allowedRoots = await this.getSessionManagerRoots(normalized);
    const thread = await this.readSelectedThread(threadId);
    const workspaceRoot = normalizeWorkspacePath(thread.cwd);
    await this.requireManagedWorkspace(workspaceRoot, allowedRoots);
    this.requireIdleSession(thread, Boolean(confirmedIdle));
    await this.resumeManagedThread(thread);
    this.selectManagedThread(normalized, thread);
    await this.sendReplyToNormalized(normalized, `已续接原会话。后续消息会发到这个会话。\n\nworkspace: ${workspaceRoot}\nthread: ${threadId}`);
  }

  async resumeManagedThread(thread) {
    const response = await this.codex.resumeThread({ threadId: thread.id, excludeTurns: true });
    const resumed = response?.result?.thread;
    if (resumed?.id !== thread.id || normalizeWorkspacePath(resumed?.cwd) !== normalizeWorkspacePath(thread.cwd)) {
      throw new SessionManagerError("Codex 返回的会话与所选目标不一致，请重新选择。");
    }
    this.requireIdleSession(resumed);
    this.resumedThreadIds.add(thread.id);
  }

  selectManagedThread(normalized, thread) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    this.sessionStore.setThreadIdForWorkspace(bindingKey, normalizeWorkspacePath(thread.cwd), thread.id,
      codexMessageUtils.buildBindingMetadata(normalized), { explicit: true });
    this.taskManager.handoffs.delete(bindingKey);
    this.taskManager.choices.delete(bindingKey);
  }

  async requireManagedWorkspace(workspaceRoot, allowedRoots) {
    if (!await isManagedWorkspaceAllowed(workspaceRoot, allowedRoots)) {
      throw new SessionManagerError(allowedRoots.length
        ? "会话的工作目录不存在，或不在允许的项目白名单中。"
        : "这个会话的本地工作目录已不可用。", "SESSION_UNAVAILABLE");
    }
  }

  async resolveManagedSessionWorkspace(workspaceRoot, roots) {
    const cwd = await resolveLocalDirectory(workspaceRoot);
    return cwd && !this.isManagerThread({ cwd }) && (!roots.length || roots.some((root) => pathMatchesWorkspaceRoot(cwd, root))) ? cwd : "";
  }

  async createManagedSession(normalized, workspaceRoot) {
    const roots = await this.getSessionManagerRoots(normalized);
    const cwd = await this.resolveManagedSessionWorkspace(workspaceRoot, roots);
    if (!cwd) throw new SessionManagerError("这个项目目录不可用，无法创建会话。");
    const prepared = await this.prepareIncomingMessageForCodex(normalized, cwd);
    if (!prepared) return;
    const response = await this.codex.startThread({ cwd });
    const thread = response?.result?.thread;
    if (!thread?.id || thread.ephemeral || normalizeWorkspacePath(thread.cwd) !== normalizeWorkspacePath(cwd)) {
      throw Object.assign(new Error("Codex 没有返回可核对的新会话"), { code: "CODEX_ACK_UNKNOWN", rpcMethod: "thread/start" });
    }
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const title = normalized.newSessionTitle;
    this.resumedThreadIds.add(thread.id);
    this.sessionStore.setManagerTarget(bindingKey, { id: thread.id, cwd, title, task: normalized.taskLabel });
    try {
      await this.codex.sendRequest("thread/name/set", { threadId: thread.id, name: title });
    } catch (error) {
      console.warn(`[codex-wechat] could not set new thread name: ${error.code || error.rpcMethod || "unknown"}`);
    }
    await this.submitUserMessage({ id: thread.id, bindingKey, workspaceRoot: cwd,
      normalized: { ...prepared, sessionLabel: title },
      codexParams: this.getCodexParamsForWorkspace(bindingKey, cwd) });
  }

  async sessionStatusLabel(thread) {
    const status = typeof thread.status === "string" ? { type: thread.status, activeFlags: thread.activeFlags } : thread.status;
    if (status?.type !== "notLoaded") return describeSessionStatus(status);
    try {
      const response = await this.codex.sendRequest("thread/turns/list", {
        threadId: thread.id, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
      }, { timeoutMs: 1_500, observeTimeout: false });
      const last = response?.result?.data?.[0];
      if (last?.status === "interrupted" && !(last.completedAt > 0)) return "本轮尚无结束记录";
      return { completed: "上次完成", failed: "上次失败", interrupted: "上次中断", inProgress: "上次记录未结束" }[last?.status] || "历史可查";
    } catch {
      return "历史可查";
    }
  }

  async *listManagedSessions(allowedRoots) {
    const allowedWorkspaces = new Map();
    for await (const threads of this.listCodexThreadPages({
      maxPages: Infinity, sourceKinds: MANAGED_SESSION_SOURCES, modelProviders: [],
    })) {
      for (const thread of threads) {
        if (!allowedRoots.length) {
          yield thread;
          continue;
        }
        if (!allowedWorkspaces.has(thread.cwd)) {
          allowedWorkspaces.set(thread.cwd, await isManagedWorkspaceAllowed(thread.cwd, allowedRoots));
        }
        if (allowedWorkspaces.get(thread.cwd)) yield thread;
      }
    }
  }

  async getSessionManagerRoots(normalized) {
    if (!this.config.allowedUserIds?.includes(normalized.senderId)) {
      throw new SessionManagerError("会话管理需要配置微信用户白名单。");
    }
    if (this.config.allLocalSessions) return [];
    if (!this.config.workspaceAllowlist?.length) throw new SessionManagerError("请配置项目目录白名单，或启用全部本机会话。");
    const roots = (await Promise.all(this.config.workspaceAllowlist.map(resolveLocalDirectory))).filter(Boolean);
    if (!roots.length) {
      throw new SessionManagerError("项目目录白名单里没有可用的本地目录。");
    }
    return roots;
  }

  async readSelectedThread(threadId, workspaceRoot) {
    try {
      const response = await this.codex.readThread(threadId);
      const thread = response?.result?.thread;
      if (threadId && thread?.id === threadId) {
        if (this.isManagerThread(thread)) throw new SessionManagerError("这是总管的专用会话。请指定项目会话。", "SESSION_UNAVAILABLE");
        if (workspaceRoot && normalizeWorkspacePath(thread.cwd) !== workspaceRoot) {
          throw new SessionManagerError("会话的工作目录已变更，请重新用 /codex use 选中该会话。", "SESSION_UNAVAILABLE");
        }
        if (this.config.allLocalSessions && !await this.isVisibleLocalThread(thread)) {
          throw new SessionManagerError("该会话已归档，或已不在本机可见列表中。", "SESSION_UNAVAILABLE");
        }
        return thread;
      }
    } catch (error) {
      if (!shouldRecreateThread(error)) {
        throw error;
      }
    }
    throw new SessionManagerError("找不到指定的 Codex 会话，请使用 /codex sessions 查看后重新选择。", "SESSION_UNAVAILABLE");
  }

  isManagerThread(thread) {
    return this.sessionStore.isManagerThread(thread.id) || pathMatchesWorkspaceRoot(thread.cwd, this.managerWorkspace);
  }

  async isVisibleLocalThread(thread) {
    for await (const page of this.listCodexThreadPages({
      maxPages: Infinity, sourceKinds: MANAGED_SESSION_SOURCES, modelProviders: [], cwd: thread.cwd,
    })) {
      if (page.some(({ id }) => id === thread.id)) return true;
    }
    return false;
  }

  requireIdleSession(thread, confirmedIdle = false) {
    const status = thread.status?.type;
    if (status === "active" || this.activeTurnIdByThreadId.has(thread.id)) {
      throw new SessionManagerError("会话正在运行，请等当前任务结束后再操作。");
    }
    if (status === "notLoaded" && !confirmedIdle) {
      throw new SessionManagerError(`请先在 Codex App 确认原任务已结束并关闭会话，再发送 /codex use ${thread.id} --confirm-idle`);
    }
    if (status !== "idle" && status !== "notLoaded") {
      throw new SessionManagerError("无法确认会话空闲，请在原客户端检查后重试。");
    }
  }

  async handleNewCommand(normalized) {
    const workspaceContext = await this.resolveWorkspaceContext(normalized);
    if (!workspaceContext) {
      return;
    }
    const { bindingKey, workspaceRoot } = workspaceContext;
    this.sessionStore.setPendingNewThreadForWorkspace(bindingKey, workspaceRoot, true);
    this.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    await this.sendReplyToNormalized(
      normalized,
      `已切换到新会话，\n\nworkspace: ${workspaceRoot}\n。`
    );
  }

  async handleSwitchCommand(normalized) {
    const targetThreadId = extractSwitchThreadId(normalized.text);
    if (!targetThreadId) {
      await this.sendReplyToNormalized(normalized, "用法: `/codex switch <threadId>`");
      return;
    }

    const workspaceContext = await this.resolveWorkspaceContext(normalized);
    if (!workspaceContext) {
      return;
    }
    const { bindingKey, workspaceRoot } = workspaceContext;
    const threads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const selectedThread = threads.find((thread) => thread.id === targetThreadId);
    if (!selectedThread) {
      await this.sendReplyToNormalized(normalized, "指定线程当前不可用，请刷新后重试。");
      return;
    }

    const resolvedWorkspaceRoot = selectedThread.cwd || workspaceRoot;
    this.sessionStore.setActiveWorkspaceRoot(bindingKey, resolvedWorkspaceRoot);
    this.sessionStore.setPendingNewThreadForWorkspace(bindingKey, resolvedWorkspaceRoot, false);
    this.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      resolvedWorkspaceRoot,
      targetThreadId,
      codexMessageUtils.buildBindingMetadata(normalized)
    );
    this.resumedThreadIds.delete(targetThreadId);
    await this.ensureThreadResumed(targetThreadId);
    await this.sendReplyToNormalized(
      normalized,
      `已切换线程。\n\nworkspace: ${resolvedWorkspaceRoot}\nthread: ${targetThreadId}`
    );
  }

  async handleMessageCommand(normalized) {
    const workspaceContext = await this.resolveWorkspaceContext(normalized);
    if (!workspaceContext) {
      return;
    }
    const { bindingKey, workspaceRoot } = workspaceContext;
    if (this.sessionStore.hasPendingNewThreadForWorkspace(bindingKey, workspaceRoot)) {
      await this.sendReplyToNormalized(normalized, "当前是新会话，还没有历史消息。先发送一条普通消息开始。");
      return;
    }
    const { threads, threadId } = await this.resolveWorkspaceThreadState({
      bindingKey,
      workspaceRoot,
      normalized,
      autoSelectThread: true,
    });
    if (!threadId) {
      await this.sendReplyToNormalized(normalized, "当前项目还没有可查看的线程消息。");
      return;
    }

    let recentMessages;
    if (this.sessionStore.isExplicitThreadSelection(bindingKey, workspaceRoot)) {
      await this.readSelectedThread(threadId, workspaceRoot);
      const response = await this.codex.sendRequest("thread/turns/list", {
        threadId, limit: 3, sortDirection: "desc", itemsView: "full",
      });
      recentMessages = codexMessageUtils.extractRecentConversation((response?.result?.data || []).slice().reverse());
    } else {
      this.resumedThreadIds.delete(threadId);
      let resumeResponse = null;
      try {
        resumeResponse = await this.ensureThreadResumed(threadId);
      } catch (error) {
        if (!isNoRolloutFoundError(error)) {
          throw error;
        }
        this.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        await this.sendReplyToNormalized(normalized, "当前线程还没有历史消息。先发送一条普通消息开始。");
        return;
      }
      recentMessages = codexMessageUtils.extractRecentConversationFromResumeResponse(resumeResponse);
    }
    const currentThread = threads.find((thread) => thread.id === threadId) || { id: threadId };
    const lines = [
      `workspace: ${workspaceRoot}`,
      `thread: ${currentThread.id}`,
      "",
    ];
    if (!recentMessages.length) {
      lines.push("暂无最近消息。");
    } else {
      for (const message of recentMessages) {
        lines.push(`${message.role === "assistant" ? "assistant" : "user"}: ${message.text}`);
      }
    }
    await this.sendReplyToNormalized(normalized, lines.join("\n"));
  }

  async handleStopCommand(normalized) {
    const { threadId } = this.getCurrentThreadContext(normalized);
    const turnId = threadId ? this.activeTurnIdByThreadId.get(threadId) || null : null;
    if (!threadId) {
      await this.sendReplyToNormalized(normalized, "当前会话还没有可停止的运行任务。");
      return;
    }

    await this.codex.sendRequest("turn/cancel", {
      threadId,
      turnId,
    });
    await this.stopTypingForThread(threadId);


    await this.sendReplyToNormalized(normalized, "已发送停止请求。");
  }

  async handleModelCommand(normalized) {
    const requested = extractModelValue(normalized.text);
    if (requested.toLowerCase() === "update") {
      const response = await this.codex.listModels();
      const models = extractModelCatalogFromListResponse(response);
      if (!models.length) {
        await this.sendReplyToNormalized(normalized, "model/list 返回空结果。");
        return;
      }
      this.sessionStore.setAvailableModelCatalog(models);
      await this.sendReplyToNormalized(normalized, `已刷新模型列表，共 ${models.length} 个。`);
      return;
    }

    const workspaceContext = await this.resolveWorkspaceContext(normalized, false);
    const catalog = this.sessionStore.getAvailableModelCatalog();
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    if (!requested) {
      const currentModel = workspaceContext
        ? this.getCodexParamsForWorkspace(workspaceContext.bindingKey, workspaceContext.workspaceRoot).model
        : "";
      const lines = [
        `当前模型: ${currentModel || "(default)"}`,
        "",
        "可用模型：",
      ];
      for (const model of models) {
        lines.push(`- ${model.model}${model.isDefault ? " (default)" : ""}`);
      }
      await this.sendReplyToNormalized(normalized, lines.join("\n"));
      return;
    }

    if (!workspaceContext) {
      await this.sendReplyToNormalized(normalized, "当前会话还未绑定项目，无法设置模型。");
      return;
    }

    const matched = findModelByQuery(models, requested);
    if (!matched) {
      await this.sendReplyToNormalized(normalized, `未找到模型: ${requested}`);
      return;
    }

    const currentParams = this.getCodexParamsForWorkspace(workspaceContext.bindingKey, workspaceContext.workspaceRoot);
    const currentEffort = currentParams.effort;
    const supported = matched.supportedReasoningEfforts || [];
    const nextEffort = supported.length && currentEffort && supported.includes(currentEffort)
      ? currentEffort
      : matched.defaultReasoningEffort || "";
    this.sessionStore.setCodexParamsForWorkspace(
      workspaceContext.bindingKey,
      workspaceContext.workspaceRoot,
      { model: matched.model, effort: nextEffort }
    );
    await this.sendReplyToNormalized(
      normalized,
      `已设置模型。\n\nworkspace: ${workspaceContext.workspaceRoot}\nmodel: ${matched.model}\neffort: ${nextEffort || "(default)"}`
    );
  }

  async handleEffortCommand(normalized) {
    const requested = extractEffortValue(normalized.text);
    const workspaceContext = await this.resolveWorkspaceContext(normalized, false);
    if (!workspaceContext) {
      await this.sendReplyToNormalized(normalized, "当前会话还未绑定项目，无法设置推理强度。");
      return;
    }

    const catalog = this.sessionStore.getAvailableModelCatalog();
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    const currentParams = this.getCodexParamsForWorkspace(workspaceContext.bindingKey, workspaceContext.workspaceRoot);
    const effectiveModel = resolveEffectiveModelForEffort(models, currentParams.model);
    const supported = effectiveModel?.supportedReasoningEfforts || [];
    if (!requested) {
      const lines = [
        `当前模型: ${effectiveModel?.model || currentParams.model || "(default)"}`,
        `当前推理强度: ${currentParams.effort || "(default)"}`,
      ];
      if (supported.length) {
        lines.push("", `可用推理强度: ${supported.join(", ")}`);
      }
      await this.sendReplyToNormalized(normalized, lines.join("\n"));
      return;
    }

    if (supported.length && !supported.includes(requested)) {
      await this.sendReplyToNormalized(
        normalized,
        `当前模型不支持该推理强度: ${requested}\n支持: ${supported.join(", ")}`
      );
      return;
    }

    this.sessionStore.setCodexParamsForWorkspace(
      workspaceContext.bindingKey,
      workspaceContext.workspaceRoot,
      { model: effectiveModel?.model || currentParams.model || "", effort: requested }
    );
    await this.sendReplyToNormalized(
      normalized,
      `已设置推理强度。\n\nworkspace: ${workspaceContext.workspaceRoot}\neffort: ${requested}`
    );
  }

  async handleApprovalCommand(normalized) {
    const { workspaceRoot, threadId } = this.getCurrentThreadContext(normalized);
    const approval = threadId ? this.pendingApprovalByThreadId.get(threadId) || null : null;
    if (!threadId || !approval) {
      await this.sendReplyToNormalized(normalized, "当前没有待处理的授权请求。");
      return;
    }

    const outcome = await this.applyApprovalDecision({
      threadId,
      approval,
      command: normalized.command,
      workspaceRoot,
      scope: codexMessageUtils.isWorkspaceApprovalCommand(normalized.text) ? "workspace" : "once",
    });
    if (outcome.error) {
      throw outcome.error;
    }
    if (outcome.ignoredAsDuplicate) {
      await this.sendReplyToNormalized(normalized, "该授权请求正在处理中，请稍后。");
      return;
    }
    const text = outcome.decision === "accept"
      ? (outcome.scope === "workspace" && codexMessageUtils.isCommandApprovalMethod(outcome.method)
        ? "已自动允许该命令，后续同工作区下相同前缀命令将自动放行。"
        : "已允许本次请求。")
      : "已拒绝本次请求。";
    await this.sendReplyToNormalized(normalized, text);
  }

  async handleRemoveCommand(normalized) {
    const target = extractRemoveWorkspacePath(normalized.text);
    if (!target) {
      await this.sendReplyToNormalized(normalized, "用法: `/codex remove /绝对路径`");
      return;
    }
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = normalizeWorkspacePath(target);
    this.sessionStore.removeWorkspace(bindingKey, workspaceRoot);
    await this.sendReplyToNormalized(normalized, `已移除项目绑定: ${workspaceRoot}`);
  }

  async handleSendCommand(normalized) {
    const requestedPath = extractSendPath(normalized.text);
    if (!requestedPath) {
      await this.sendReplyToNormalized(normalized, "用法: `/codex send <相对文件路径>`");
      return;
    }

    const workspaceContext = await this.resolveWorkspaceContext(normalized);
    if (!workspaceContext) {
      return;
    }

    const resolvedPath = this.resolveWorkspaceFilePath(workspaceContext.workspaceRoot, requestedPath);
    if (!resolvedPath) {
      await this.sendReplyToNormalized(normalized, "只允许发送当前项目目录内的文件。");
      return;
    }

    let stats = null;
    try {
      stats = await fs.promises.stat(resolvedPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        await this.sendReplyToNormalized(normalized, `文件不存在: ${requestedPath}`);
        return;
      }
      throw error;
    }

    if (!stats.isFile()) {
      await this.sendReplyToNormalized(normalized, `只能发送文件，不能发送目录: ${requestedPath}`);
      return;
    }

    await sendWeixinMediaFile({
      filePath: resolvedPath,
      to: normalized.senderId,
      contextToken: normalized.contextToken || this.contextTokenByUserId.get(normalized.senderId) || "",
      baseUrl: this.account.baseUrl,
      token: this.account.token,
      cdnBaseUrl: this.config.cdnBaseUrl,
    });
  }

  async handleHelpCommand(normalized) {
    await this.sendReplyToNormalized(normalized, this.buildHelpText());
  }

  buildHelpText() {
    return [
      "可用命令：",
      "/codex bind /绝对路径",
      "/codex where",
      "/codex workspace",
      "/codex sessions [页码]",
      "/codex use <会话ID> [--confirm-idle]",
      "/codex new",
      "/codex switch <threadId>",
      "/codex message",
      "/codex stop",
      "/codex model",
      "/codex model update",
      "/codex model <modelId>",
      "/codex effort",
      "/codex effort <low|medium|high|xhigh>",
      "/codex approve",
      "/codex approve workspace",
      "/codex reject",
      "/codex send <相对文件路径>",
      "/codex remove /绝对路径",
      "/codex help",
      "/codex status",
      "/codex summary [会话ID]",
      "",
      "普通文本消息会直接发送给当前项目对应的 Codex 线程。",
    ].join("\n");
  }

  async resolveWorkspaceContext(normalized, sendMissingMessage = true) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    let workspaceRoot = this.sessionStore.getActiveWorkspaceRoot(bindingKey);
    if (!workspaceRoot && this.config.defaultWorkspaceRoot) {
      workspaceRoot = normalizeWorkspacePath(this.config.defaultWorkspaceRoot);
      this.applyDefaultCodexParamsOnBind(bindingKey, workspaceRoot);
      this.sessionStore.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    }

    if (!workspaceRoot) {
      if (sendMissingMessage) {
        await this.sendReplyToNormalized(
          normalized,
          "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`，或配置 CODEX_WECHAT_DEFAULT_WORKSPACE。"
        );
      }
      return null;
    }
    if (this.sessionStore.isExplicitThreadSelection(bindingKey, workspaceRoot)) {
      const allowedRoots = await this.getSessionManagerRoots(normalized);
      await this.requireManagedWorkspace(workspaceRoot, allowedRoots);
    }
    return { bindingKey, workspaceRoot };
  }

  async prepareIncomingMessageForCodex(normalized, workspaceRoot) {
    const attachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
    if (!attachments.length) {
      return normalized;
    }

    const persisted = await persistIncomingWeixinAttachments({
      attachments,
      workspaceRoot,
      cdnBaseUrl: this.config.cdnBaseUrl,
      messageId: normalized.messageId,
      receivedAt: normalized.receivedAt,
    });
    if (
      !persisted.saved.length
      && persisted.failed.length
      && !String(normalized.text || "").trim()
    ) {
      await this.sendReplyToNormalized(
        normalized,
        `Attachment transfer failed: ${persisted.failed.map((item) => item.reason).join("; ")}`
      );
      return null;
    }

    const text = buildCodexInboundText(normalized.text, persisted);
    if (!text) {
      await this.sendReplyToNormalized(
        normalized,
        `Attachment transfer failed: ${persisted.failed.map((item) => item.reason).join("; ")}`
      );
      return null;
    }

    return {
      ...normalized,
      originalText: normalized.text,
      text,
      attachments: persisted.saved,
      attachmentFailures: persisted.failed,
    };
  }

  getBindingContext(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = this.sessionStore.getActiveWorkspaceRoot(bindingKey);
    return { bindingKey, workspaceRoot };
  }

  getCurrentThreadContext(normalized) {
    const { bindingKey, workspaceRoot } = this.getBindingContext(normalized);
    const threadId = workspaceRoot ? this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot) : "";
    return { bindingKey, workspaceRoot, threadId };
  }

  applyDefaultCodexParamsOnBind(bindingKey, workspaceRoot) {
    const current = this.sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    if (current.model || current.effort) {
      return;
    }

    const catalog = this.sessionStore.getAvailableModelCatalog();
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    const defaultModel = this.config.defaultCodexModel
      ? findModelByQuery(models, this.config.defaultCodexModel)
      : (models.find((item) => item.isDefault) || models[0] || null);
    const defaultEffort = this.config.defaultCodexEffort
      || defaultModel?.defaultReasoningEffort
      || "";

    this.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
      model: defaultModel?.model || this.config.defaultCodexModel || "",
      effort: defaultEffort,
    });
  }

  getCodexParamsForWorkspace(bindingKey, workspaceRoot) {
    const current = this.sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    if (current.model || current.effort) {
      return current;
    }
    return {
      model: this.config.defaultCodexModel || "",
      effort: this.config.defaultCodexEffort || "",
    };
  }

  async resolveWorkspaceStats(workspaceRoot) {
    try {
      const stats = await fs.promises.stat(workspaceRoot);
      return {
        exists: true,
        isDirectory: stats.isDirectory(),
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { exists: false, isDirectory: false };
      }
      throw error;
    }
  }

  async resolveWorkspaceThreadState({ bindingKey, workspaceRoot, normalized, autoSelectThread = true }) {
    const threads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const hasPendingNewThread = this.sessionStore.hasPendingNewThreadForWorkspace(bindingKey, workspaceRoot);
    const selectedThreadId = this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadId = hasPendingNewThread
      ? ""
      : (selectedThreadId || (autoSelectThread ? (threads[0]?.id || "") : ""));
    if (!selectedThreadId && threadId) {
      this.sessionStore.setThreadIdForWorkspace(
        bindingKey,
        workspaceRoot,
        threadId,
        codexMessageUtils.buildBindingMetadata(normalized)
      );
    }
    if (threadId) {
      this.bindingKeyByThreadId.set(threadId, bindingKey);
      this.workspaceRootByThreadId.set(threadId, workspaceRoot);
    }
    return { threads, threadId, selectedThreadId };
  }

  async refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized) {
    try {
      const threads = await this.listCodexThreadsForWorkspace(workspaceRoot);
      const currentThreadId = this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      const shouldKeepCurrentThread = this.sessionStore.isExplicitThreadSelection(bindingKey, workspaceRoot)
        || this.resumedThreadIds.has(currentThreadId);
      if (currentThreadId && !shouldKeepCurrentThread && !threads.some((thread) => thread.id === currentThreadId)) {
        this.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      }
      return threads;
    } catch (error) {
      console.warn(`[codex-wechat] thread/list failed for workspace=${workspaceRoot}: ${error.message}`);
      return [];
    }
  }

  async listCodexThreadsForWorkspace(workspaceRoot) {
    const allThreads = [];
    for await (const threads of this.listCodexThreadPages()) {
      allThreads.push(...threads);
    }
    return filterThreadsByWorkspaceRoot(allThreads, workspaceRoot);
  }

  async *listCodexThreadPages({ maxPages = 10, sourceKinds, modelProviders, cwd } = {}) {
    const seenThreadIds = new Set();
    const seenCursors = new Set();
    let cursor = null;

    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.codex.listThreads({
        cursor,
        limit: 200,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds,
        modelProviders,
        cwd,
      });
      const pageThreads = codexMessageUtils.extractThreadsFromListResponse(response);
      const threads = [];
      for (const thread of pageThreads) {
        if (this.isManagerThread(thread)) continue;
        if (!THREAD_SOURCE_KINDS.has(thread.sourceKind)) {
          continue;
        }
        if (seenThreadIds.has(thread.id)) {
          continue;
        }
        seenThreadIds.add(thread.id);
        threads.push(thread);
      }
      yield threads;

      const nextCursor = codexMessageUtils.extractThreadListCursor(response);
      if (!nextCursor || seenCursors.has(nextCursor)) {
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  async ensureThreadAndSendMessage({ bindingKey, workspaceRoot, normalized, threadId, explicit }) {
    const codexParams = this.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    const submit = (id) => this.submitUserMessage({ id, bindingKey, workspaceRoot, normalized, codexParams });

    if (!threadId) {
      const createdThreadId = await this.createWorkspaceThread({
        bindingKey,
        workspaceRoot,
        normalized,
      });
      return submit(createdThreadId);
    }

    try {
      await this.ensureThreadResumed(threadId);
      return await submit(threadId);
    } catch (error) {
      if (!shouldRecreateThread(error)) {
        throw error;
      }
      if (explicit) {
        throw new SessionManagerError("已选中的 Codex 会话不可用，请使用 /codex sessions 重新选择。");
      }
      this.resumedThreadIds.delete(threadId);
      this.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      const recreatedThreadId = await this.createWorkspaceThread({
        bindingKey,
        workspaceRoot,
        normalized,
      });
      return submit(recreatedThreadId);
    }
  }

  async submitUserMessage({ id, bindingKey, workspaceRoot, normalized, codexParams }) {
    if (this.submittingThreads.has(id) || this.activeTurnIdByThreadId.has(id)) {
      throw new SessionManagerError("该会话仍在运行。你可以切到另一条会话继续工作。");
    }
    this.submittingThreads.add(id);
    this.pendingChatContextByThreadId.set(id, normalized);
    this.bindingKeyByThreadId.set(id, bindingKey);
    this.workspaceRootByThreadId.set(id, workspaceRoot);
    let report;
    try {
      if (normalized.inboxId) this.messageStore.waitForResult(normalized.inboxId, id);
      report = this.registerTaskReport(normalized, id, normalized.sessionLabel || path.basename(workspaceRoot));
      if (report) normalized.reportId = report.id;
      const response = await this.codex.sendUserMessage({
        threadId: id,
        text: report?.text || normalized.text,
        model: codexParams.model || null,
        effort: codexParams.effort || null,
        accessMode: normalized.readOnly ? "read-only" : this.config.defaultCodexAccessMode,
        workspaceRoot,
      });
      if (normalized.inboxId && this.messageStore.isWaiting(normalized.inboxId)) {
        const turnId = response?.result?.turn?.id;
        if (!turnId) throw Object.assign(new Error("缺少任务确认"), { code: "CODEX_ACK_UNKNOWN", rpcMethod: "turn/start" });
        this.messageStore.waitForResult(normalized.inboxId, id, turnId);
        if (report) this.messageStore.setReportTurn(report.id, turnId);
        if (this.pendingChatContextByThreadId.get(id) === normalized) this.activeTurnIdByThreadId.set(id, turnId);
        normalized.turnId = turnId;
        const task = normalized.taskLabel ? `\n任务：${normalized.taskLabel}` : "";
        const label = normalized.sessionLabel || path.basename(workspaceRoot);
        const acknowledgement = normalized.newSessionTitle ? `已在「${path.basename(workspaceRoot)}」新建「${label}」。` : `已提交给「${label}」`;
        await this.sendReplyToUser(normalized.senderId, `${acknowledgement}\n会话: ${id}${task}`,
          normalized.contextToken, report ? { finishId: normalized.inboxId } : undefined)
          .catch((error) => console.warn(`[codex-wechat] submission acknowledgement: ${error.message}`));
      }
      if (this.pendingChatContextByThreadId.get(id) === normalized) {
        void this.startTypingForThread(id, normalized).catch((error) => console.warn(`[codex-wechat] typing: ${error.message}`));
      }
    } catch (error) {
      if (report && !isUncertainSubmission(error)) this.messageStore.removeTaskReport(report.id);
      if (this.pendingChatContextByThreadId.get(id) === normalized && !this.activeTurnIdByThreadId.has(id)) {
        this.pendingChatContextByThreadId.delete(id);
      }
      throw error;
    } finally {
      this.submittingThreads.delete(id);
    }
  }

  async createWorkspaceThread({ bindingKey, workspaceRoot, normalized }) {
    const response = await this.codex.startThread({ cwd: workspaceRoot });
    const threadId = codexMessageUtils.extractThreadId(response);
    if (!threadId) {
      throw new Error("thread/start did not return a thread id");
    }
    this.sessionStore.setPendingNewThreadForWorkspace(bindingKey, workspaceRoot, false);
    this.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      threadId,
      codexMessageUtils.buildBindingMetadata(normalized)
    );
    this.resumedThreadIds.add(threadId);
    this.pendingChatContextByThreadId.set(threadId, normalized);
    this.bindingKeyByThreadId.set(threadId, bindingKey);
    this.workspaceRootByThreadId.set(threadId, workspaceRoot);
    return threadId;
  }

  async ensureThreadResumed(threadId) {
    const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    if (!normalizedThreadId || this.resumedThreadIds.has(normalizedThreadId)) {
      return null;
    }

    const response = await this.codex.resumeThread({ threadId: normalizedThreadId });
    this.resumedThreadIds.add(normalizedThreadId);
    return response;
  }

  describeWorkspaceStatus(threadId) {
    if (!threadId) {
      return { code: "idle", label: "空闲" };
    }
    if (this.pendingApprovalByThreadId.has(threadId)) {
      return { code: "approval", label: "等待授权" };
    }
    if (this.activeTurnIdByThreadId.has(threadId)) {
      return { code: "running", label: "运行中" };
    }
    return { code: "idle", label: "空闲" };
  }

  async sendReplyToNormalized(normalized, text) {
    return this.sendReplyToUser(normalized.senderId, text, normalized.contextToken);
  }

  async sendReplyToUser(userId, text, contextToken = "", deliveryOptions = {}) {
    const messages = this.buildTextReply(userId, text, contextToken);
    if (this.messageStore) {
      this.messageStore.enqueueReplies(messages, deliveryOptions);
      return;
    }
    for (const message of messages) await this.sendWeixinText(message);
  }

  buildTextReply(userId, text, contextToken) {
    const resolvedToken = contextToken || this.contextTokenByUserId.get(userId) || "";
    if (!resolvedToken) {
      throw new Error(`缺少 context_token，无法回复用户 ${userId}`);
    }

    return buildWeixinTextMessages(userId, text, resolvedToken);
  }

  async sendWeixinText(message) {
    await sendMessage({ baseUrl: this.account.baseUrl, token: this.account.token, body: { msg: message } });
  }

  resolveWorkspaceFilePath(workspaceRoot, requestedPath) {
    const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
    const rawRequestedPath = String(requestedPath || "").trim();
    if (!normalizedWorkspaceRoot || !rawRequestedPath) {
      return "";
    }

    const candidatePath = path.resolve(normalizedWorkspaceRoot, rawRequestedPath);
    const normalizedCandidatePath = normalizeWorkspacePath(candidatePath);
    if (!pathMatchesWorkspaceRoot(normalizedCandidatePath, normalizedWorkspaceRoot)) {
      return "";
    }
    return candidatePath;
  }

  async sendAssistantAttachmentsForReply({ userId, contextToken, workspaceRoot, replyText }) {
    const filePaths = await extractAutoSendFilePathsFromReply(replyText, workspaceRoot);
    const sent = [];
    const failed = [];

    for (const filePath of filePaths) {
      try {
        const outcome = await sendWeixinMediaFile({
          filePath,
          to: userId,
          contextToken,
          baseUrl: this.account.baseUrl,
          token: this.account.token,
          cdnBaseUrl: this.config.cdnBaseUrl,
        });
        sent.push({
          filePath,
          kind: outcome.kind,
          fileName: outcome.fileName,
        });
      } catch (error) {
        failed.push({
          filePath,
          reason: error instanceof Error ? error.message : String(error || "unknown upload error"),
        });
      }
    }

    return { sent, failed };
  }

  async startTypingForThread(threadId, normalized) {
    if (!this.config.enableTyping || !threadId) {
      return;
    }

    await this.stopTypingForThread(threadId);
    const contextToken = normalized.contextToken || this.contextTokenByUserId.get(normalized.senderId) || "";
    if (!contextToken) {
      return;
    }

    const configResponse = await getConfig({
      baseUrl: this.account.baseUrl,
      token: this.account.token,
      ilinkUserId: normalized.senderId,
      contextToken,
    }).catch(() => null);
    const typingTicket = typeof configResponse?.typing_ticket === "string"
      ? configResponse.typing_ticket.trim()
      : "";
    if (!typingTicket || this.pendingChatContextByThreadId.get(threadId) !== normalized) {
      return;
    }

    const sendStatus = async (status) => {
      await sendTyping({
        baseUrl: this.account.baseUrl,
        token: this.account.token,
        body: {
          ilink_user_id: normalized.senderId,
          typing_ticket: typingTicket,
          status,
        },
      });
    };

    await sendStatus(1).catch(() => {});
    if (this.pendingChatContextByThreadId.get(threadId) !== normalized) {
      await sendStatus(2).catch(() => {});
      return;
    }
    const timer = setInterval(() => {
      sendStatus(1).catch(() => {});
    }, TYPING_KEEPALIVE_MS);

    this.typingStopByThreadId.set(threadId, async () => {
      clearInterval(timer);
      await sendStatus(2).catch(() => {});
    });
  }

  async stopTypingForThread(threadId) {
    const stop = this.typingStopByThreadId.get(threadId);
    if (!stop) {
      return;
    }
    this.typingStopByThreadId.delete(threadId);
    await stop();
  }

  async handleCodexMessage(message) {
    codexMessageUtils.trackRunningTurn(this.activeTurnIdByThreadId, message);
    codexMessageUtils.trackPendingApproval(this.pendingApprovalByThreadId, message);
    codexMessageUtils.trackRunKeyState(this.currentRunKeyByThreadId, this.activeTurnIdByThreadId, message);

    const outbound = codexMessageUtils.mapCodexMessageToImEvent(message);
    if (!outbound) {
      return;
    }

    const threadId = outbound.payload?.threadId || "";
    if (outbound.type === "im.agent_reply") {
      this.appendAssistantReplyBuffer(message, outbound);
      return;
    }

    if (outbound.type === "im.approval_request") {
      await this.handleApprovalRequest(threadId);
      return;
    }

    if (outbound.type === "im.run_state") {
      await this.handleRunState(outbound);
    }
  }

  appendAssistantReplyBuffer(message, outbound) {
    const threadId = outbound.payload.threadId || "";
    const turnId = outbound.payload.turnId || this.activeTurnIdByThreadId.get(threadId) || "";
    if (!threadId) {
      return;
    }
    const runKey = this.currentRunKeyByThreadId.get(threadId) || codexMessageUtils.buildRunKey(threadId, turnId);
    const current = this.replyBufferByRunKey.get(runKey) || "";
    const text = outbound.payload.text || "";
    if (!text) {
      return;
    }

    if (message?.method === "item/agentMessage/delta") {
      this.replyBufferByRunKey.set(runKey, `${current}${text}`);
      return;
    }

    if (!current) {
      this.replyBufferByRunKey.set(runKey, text);
    }
  }

  async handleApprovalRequest(threadId) {
    if (!threadId) {
      return;
    }
    const approval = this.pendingApprovalByThreadId.get(threadId);
    if (!approval) {
      return;
    }

    const workspaceRoot = this.workspaceRootByThreadId.get(threadId) || "";
    if (this.shouldAutoApproveRequest(workspaceRoot, approval)) {
      const outcome = await this.applyApprovalDecision({
        threadId,
        approval,
        command: "approve",
        workspaceRoot,
        scope: "once",
      });
      if (!outcome.error) {
        return;
      }
    }

    await this.stopTypingForThread(threadId);
    const context = this.pendingChatContextByThreadId.get(threadId);
    if (!context) {
      return;
    }
    const commandText = approval.command || approval.reason || "(unknown)";
    const text = [
      "Codex 请求授权：",
      commandText,
      "",
      "回复以下命令继续：",
      "/codex approve",
      "/codex approve workspace",
      "/codex reject",
    ].join("\n");
    await this.sendReplyToUser(context.senderId, text, context.contextToken);
  }

  shouldAutoApproveRequest(workspaceRoot, approval) {
    if (!workspaceRoot || !approval) {
      return false;
    }
    const cachedAllowlist = this.approvalAllowlistByWorkspaceRoot.get(workspaceRoot) || [];
    const allowlist = cachedAllowlist.length
      ? cachedAllowlist
      : this.sessionStore.getApprovalCommandAllowlistForWorkspace(workspaceRoot);
    if (allowlist.length && !cachedAllowlist.length) {
      this.approvalAllowlistByWorkspaceRoot.set(workspaceRoot, allowlist);
    }
    if (!allowlist.length) {
      return false;
    }
    return codexMessageUtils.matchesCommandPrefix(approval.commandTokens, allowlist);
  }

  rememberApprovalPrefixForWorkspace(workspaceRoot, commandTokens) {
    if (!workspaceRoot) {
      return;
    }
    this.sessionStore.rememberApprovalCommandPrefixForWorkspace(workspaceRoot, commandTokens);
    this.approvalAllowlistByWorkspaceRoot.set(
      workspaceRoot,
      this.sessionStore.getApprovalCommandAllowlistForWorkspace(workspaceRoot)
    );
  }

  async applyApprovalDecision({ threadId, approval, command, workspaceRoot = "", scope = "once" }) {
    const decision = command === "approve" ? "accept" : "decline";
    const isWorkspaceScope = scope === "workspace";
    const requestKey = `${threadId}:${String(approval.requestId || "").trim()}`;
    if (!requestKey || this.inFlightApprovalRequestKeys.has(requestKey)) {
      return {
        error: null,
        ignoredAsDuplicate: true,
        decision,
        scope: isWorkspaceScope ? "workspace" : "once",
        method: approval.method,
      };
    }
    this.inFlightApprovalRequestKeys.add(requestKey);

    try {
      if (
        decision === "accept"
        && isWorkspaceScope
        && codexMessageUtils.isCommandApprovalMethod(approval.method)
      ) {
        this.rememberApprovalPrefixForWorkspace(workspaceRoot, approval.commandTokens);
      }

      await this.codex.sendResponse(
        approval.requestId,
        codexMessageUtils.buildApprovalResponsePayload(decision)
      );
      this.pendingApprovalByThreadId.delete(threadId);
      return {
        error: null,
        ignoredAsDuplicate: false,
        decision,
        scope: isWorkspaceScope ? "workspace" : "once",
        method: approval.method,
      };
    } catch (error) {
      return {
        error,
        ignoredAsDuplicate: false,
        decision,
        scope: isWorkspaceScope ? "workspace" : "once",
        method: approval.method,
      };
    } finally {
      this.inFlightApprovalRequestKeys.delete(requestKey);
    }
  }

  async handleRunState(outbound) {
    const { threadId, turnId, state, text } = outbound.payload;
    if (state === "streaming") return;

    const context = this.pendingChatContextByThreadId.get(threadId);
    if (context?.turnId && turnId && context.turnId !== turnId) return;
    const workspaceRoot = this.workspaceRootByThreadId.get(threadId) || "";
    const runKey = this.currentRunKeyByThreadId.get(threadId) || codexMessageUtils.buildRunKey(threadId, turnId);
    const bufferedText = this.replyBufferByRunKey.get(runKey) || "";
    this.replyBufferByRunKey.delete(runKey);
    this.activeTurnIdByThreadId.delete(threadId);
    this.pendingApprovalByThreadId.delete(threadId);
    this.pendingChatContextByThreadId.delete(threadId);
    void this.stopTypingForThread(threadId);

    if (!context) return;
    const label = context.inboxId ? `「${context.sessionLabel || path.basename(workspaceRoot) || threadId}」\n` : "";
    const result = [bufferedText, text].filter(Boolean).join("\n\n");
    if (context.reportId) {
      if (context.turnId && context.turnId === turnId) {
        this.messageStore.setReportOutcome(context.reportId, turnId, { status: state, result: redactSensitiveText(result.slice(-3_000), 3_000) });
      }
    } else {
      const reply = result || ({ failed: "执行失败。", interrupted: "任务已中断。" }[state] || "已完成。");
      await this.sendReplyToUser(context.senderId, label + reply, context.contextToken, { finishId: context.inboxId });
    }

    if (state === "completed" && bufferedText) {
      const autoSent = await this.sendAssistantAttachmentsForReply({
        userId: context.senderId,
        contextToken: context.contextToken,
        workspaceRoot,
        replyText: bufferedText,
      });
      if (autoSent.failed.length) {
        await this.sendReplyToUser(context.senderId, buildAutoSendFailureText(autoSent.failed), context.contextToken);
      }
    }
  }

}

function isUncertainSubmission(error) {
  return error.code === "CODEX_QUEUE_UNCERTAIN"
    || (["turn/start", "thread/start"].includes(error.rpcMethod) && ["CODEX_RPC_TIMEOUT", "CODEX_DISCONNECTED", "CODEX_ACK_UNKNOWN"].includes(error.code));
}

function getLocalCommand(normalized) {
  if (normalized.command === "help" || /^(?:帮助|怎么用|有哪些命令)[？?。！!]*$/.test(normalized.text)) return "help";
  if (/^(?:\/codex status|在吗|桥接状态|微信桥接还在线吗)[？?。！!]*$/i.test(normalized.text)) return "bridge_status";
  return "";
}

function buildWeixinTextMessages(userId, text, token) {
  const chunks = chunkReplyText(markdownToPlainText(text) || "已完成。");
  return chunks.map((chunk) => ({
    client_id: crypto.randomUUID(),
    from_user_id: "",
    to_user_id: userId,
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: chunk } }],
    context_token: token,
  }));
}

async function resolveLocalDirectory(value) {
  const directory = normalizeWorkspacePath(value);
  if (!isAbsoluteWorkspacePath(directory)) {
    return "";
  }
  try {
    const resolved = await fs.promises.realpath(directory);
    return (await fs.promises.stat(resolved)).isDirectory() ? resolved : "";
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(error.code)) {
      return "";
    }
    throw error;
  }
}

async function isManagedWorkspaceAllowed(workspaceRoot, allowedRoots) {
  const resolved = await resolveLocalDirectory(workspaceRoot);
  return Boolean(resolved && (!allowedRoots.length || allowedRoots.some((root) => pathMatchesWorkspaceRoot(resolved, root))));
}

function describeSessionStatus(status) {
  if (status?.type === "active") {
    if (status.activeFlags?.includes("waitingOnApproval")) return "等待审批";
    if (status.activeFlags?.includes("waitingOnUserInput")) return "等待你回复";
    return "运行中";
  }
  return { idle: "空闲", systemError: "运行异常" }[status?.type] || "暂未获取状态";
}

function shouldRecreateThread(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("thread not found")
    || message.includes("unknown thread")
    || message.includes("no rollout found");
}

function isNoRolloutFoundError(error) {
  return String(error?.message || "").toLowerCase().includes("no rollout found");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAutoSendFailureText(failed) {
  const lines = ["è‡ªåŠ¨å‘é€é™„ä»¶å¤±è´¥:"];
  for (const item of Array.isArray(failed) ? failed : []) {
    const label = path.basename(item.filePath || "") || item.filePath || "(unknown file)";
    lines.push(`- ${label}: ${item.reason || "upload failed"}`);
  }
  return lines.join("\n");
}

async function extractAutoSendFilePathsFromReply(replyText, workspaceRoot) {
  const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    return [];
  }

  const candidates = collectAutoSendPathCandidates(replyText);
  const resolved = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const filePath = await resolveAutoSendFilePath(candidate, normalizedWorkspaceRoot);
    if (!filePath) {
      continue;
    }
    const normalized = normalizeWorkspacePath(filePath);
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    resolved.push(filePath);
  }

  return resolved;
}

function collectAutoSendPathCandidates(replyText) {
  const text = String(replyText || "");
  const candidates = [];
  const pushCandidate = (value) => {
    const normalized = normalizeTextValue(value);
    if (normalized) {
      candidates.push(normalized);
    }
  };

  const markdownLinkPattern = /!?\[[^\]]*]\(([^)\n]+)\)/g;
  let match = null;
  while ((match = markdownLinkPattern.exec(text)) !== null) {
    pushCandidate(match[1]);
  }

  const backtickPathPattern = /`([^`\n]+)`/g;
  while ((match = backtickPathPattern.exec(text)) !== null) {
    pushCandidate(match[1]);
  }

  return candidates;
}

async function resolveAutoSendFilePath(candidate, workspaceRoot) {
  const normalizedCandidate = stripAutoSendCandidateDecorations(candidate);
  if (!normalizedCandidate) {
    return "";
  }

  const normalizedAbsoluteCandidate = normalizeWorkspacePath(normalizedCandidate);
  const candidatePath = isAbsoluteWorkspacePath(normalizedCandidate)
    ? path.resolve(normalizedAbsoluteCandidate)
    : path.resolve(workspaceRoot, normalizedCandidate);
  const normalizedPath = normalizeWorkspacePath(candidatePath);
  if (!normalizedPath || !pathMatchesWorkspaceRoot(normalizedPath, workspaceRoot)) {
    return "";
  }

  try {
    const stats = await fs.promises.stat(candidatePath);
    if (!stats.isFile()) {
      return "";
    }
  } catch {
    return "";
  }

  const mime = getMimeFromFilename(candidatePath);
  if (!mime || mime === "application/octet-stream") {
    return "";
  }

  return candidatePath;
}

function stripAutoSendCandidateDecorations(candidate) {
  let value = normalizeTextValue(candidate);
  if (!value) {
    return "";
  }

  if (value.startsWith("<") && value.endsWith(">")) {
    value = value.slice(1, -1).trim();
  }

  const hashIndex = value.indexOf("#L");
  if (hashIndex >= 0) {
    value = value.slice(0, hashIndex).trim();
  }

  const lineSuffixMatch = value.match(/^(.*\.[A-Za-z0-9_-]+):\d+(?::\d+)?$/);
  if (lineSuffixMatch) {
    value = lineSuffixMatch[1];
  }

  return value;
}

function normalizeTextValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildCodexInboundText(originalText, persisted) {
  const text = String(originalText || "").trim();
  const saved = Array.isArray(persisted?.saved) ? persisted.saved : [];
  const failed = Array.isArray(persisted?.failed) ? persisted.failed : [];
  const lines = [];

  if (text) {
    lines.push(text);
  }

  if (saved.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push(text
      ? "WeChat attachment(s) saved into the current workspace:"
      : "User sent WeChat attachment(s). They were saved into the current workspace:");
    for (const item of saved) {
      const suffix = item.sourceFileName ? ` (original: ${item.sourceFileName})` : "";
      lines.push(`- [${item.kind}] ${item.relativePath}${suffix}`);
    }
    lines.push("Open the saved workspace path(s) when you need to inspect the attachment contents.");
  }

  if (failed.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push("Attachment transfer issue(s):");
    for (const item of failed) {
      const label = item.sourceFileName || item.kind || "attachment";
      lines.push(`- ${label}: ${item.reason}`);
    }
  }

  return lines.join("\n").trim();
}

module.exports = { WechatRuntime };
