const { execFile, spawn } = require("child_process");
const { once } = require("node:events");
const { promisify } = require("node:util");
const os = require("os");
const path = require("node:path");
const WebSocket = require("ws");

const IS_WINDOWS = os.platform() === "win32";
const DEFAULT_CODEX_COMMAND = "codex";
const execFileAsync = promisify(execFile);
const WINDOWS_EXECUTABLE_SUFFIX_RE = /\.(cmd|exe|bat)$/i;
const CODEX_CLIENT_INFO = {
  name: "codex_wechat_agent",
  title: "Codex Wechat Agent",
  version: "0.1.0",
};

class CodexRpcClient {
  constructor({ endpoint = "", env = process.env, codexCommand = "", timeoutMs = 8_000 }) {
    this.endpoint = endpoint;
    this.env = env;
    this.codexCommand = codexCommand || resolveDefaultCodexCommand(env);
    this.mode = endpoint ? "websocket" : "spawn";
    this.socket = null;
    this.child = null;
    this.stdoutBuffer = "";
    this.pending = new Map();
    this.isReady = false;
    this.timeoutMs = timeoutMs;
    this.lastRpcResponseAt = 0;
    this.lastRpcTimeoutAt = 0;
    this.messageListeners = new Set();
    this.disconnectListeners = new Set();
  }

  async connect() {
    if (this.mode === "websocket") {
      await this.connectWebSocket();
      return;
    }

    await this.connectSpawn();
  }

  async connectSpawn() {
    const commandCandidates = buildCodexCommandCandidates(this.codexCommand);
    let child = null;
    let lastError = null;
    let selectedCommand = "";

    for (const command of commandCandidates) {
      try {
        const spawnSpec = buildSpawnSpec(command);
        const candidate = spawn(spawnSpec.command, spawnSpec.args, {
          env: { ...this.env },
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
        await once(candidate, "spawn");
        child = candidate;
        selectedCommand = command;
        console.log(`[codex-wechat] spawned Codex app-server via ${spawnSpec.command}`);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== "ENOENT" && error?.code !== "EINVAL") {
          throw error;
        }
      }
    }

    if (!child) {
      const attempted = commandCandidates.join(", ");
      const detail = lastError?.message ? `: ${lastError.message}` : "";
      throw new Error(`Unable to spawn Codex app-server. Tried ${attempted}${detail}. You can override with CODEX_WECHAT_CODEX_COMMAND.`);
    }

    this.child = child;
    this.stdoutBuffer = "";
    const disconnected = () => {
      if (this.child !== child) return;
      this.child = null;
      this.handleDisconnect();
    };

    child.on("error", (error) => {
      disconnected();
      console.error(`[codex-wechat] failed to spawn Codex app-server via ${selectedCommand || this.codexCommand}: ${error.message}`);
    });
    child.stdin.on("error", () => {
      disconnected();
      child.kill();
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (this.child !== child) return;
      this.stdoutBuffer += chunk;
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        this.handleIncoming(trimmed);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        console.error(`[codex-wechat] codex stderr: ${text}`);
      }
    });

    child.on("close", (code) => {
      disconnected();
      console.error(`[codex-wechat] codex app-server exited with code ${code}`);
    });
  }

  async connectWebSocket() {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.endpoint, { handshakeTimeout: this.timeoutMs });
      this.socket = socket;

      socket.on("open", () => {
        console.log("[codex-wechat] connected to configured Codex app-server");
        resolve();
      });
      socket.on("error", reject);
      socket.on("message", (chunk) => {
        if (this.socket !== socket) return;
        const message = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (message.trim()) {
          this.handleIncoming(message);
        }
      });
      socket.on("close", () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.handleDisconnect();
      });
    });
  }

  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onDisconnect(listener) {
    this.disconnectListeners.add(listener);
  }

  handleDisconnect() {
    this.isReady = false;
    for (const [id, pending] of this.pending) {
      this.rejectPending(id, rpcTransportError("CODEX_DISCONNECTED", pending.method, "Codex 连接已断开"));
    }
    for (const listener of this.disconnectListeners) listener();
  }

  close() {
    this.child?.kill();
    this.socket?.terminate();
  }

  rejectPending(id, error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }

  async initialize() {
    if (this.isReady) {
      return;
    }

    await this.sendRequest("initialize", {
      clientInfo: CODEX_CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
      },
    });
    await this.sendNotification("initialized", null);
    this.isReady = true;
  }

  async sendUserMessage({
    threadId,
    text,
    model = null,
    effort = null,
    accessMode = null,
    workspaceRoot = "",
  }) {
    const input = buildTurnInputPayload(text);
    return threadId
      ? this.sendRequest(
        "turn/start",
        buildTurnStartParams({
          threadId,
          input,
          model,
          effort,
          accessMode,
          workspaceRoot,
        })
      )
      : this.sendRequest("thread/start", { input });
  }

  async startThread({ cwd }) {
    return this.sendRequest("thread/start", buildStartThreadParams(cwd));
  }

  async readThread(threadId) {
    return this.sendRequest("thread/read", { threadId, includeTurns: false });
  }

  async hasDesktopThreadOwner(threadId) {
    return /\/(?:ChatGPT|Codex)\.app\/Contents\/.+\/codex$/i.test(await this.readLocalThreadWriter(threadId));
  }

  async hasLocalThreadWriter(threadId) {
    return /(?:^|\/)codex$/i.test(await this.readLocalThreadWriter(threadId));
  }

  async readLocalThreadWriter(threadId) {
    if (process.platform !== "darwin" || (this.endpoint && !this.endpoint.startsWith("ws+unix://"))
      || !/^[a-f0-9-]{36}$/i.test(threadId)) return "";
    const home = this.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const lock = path.join(home, "thread-writer-locks", `${threadId}.lock`);
    const options = { timeout: 1_500, maxBuffer: 4_096 };
    try {
      const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-nP", "-t", "--", lock], options);
      const pid = stdout.trim();
      if (!/^\d+$/.test(pid)) return "";
      const owner = await execFileAsync("/bin/ps", ["-p", pid, "-o", "comm="], options);
      return owner.stdout.trim();
    } catch {
      return "";
    }
  }

  async enqueueExistingThread(threadId, text) {
    if (this.endpoint && !this.endpoint.startsWith("ws+unix://")) {
      throw new Error("当前 Codex 连接与本机队列不在同一个主机上。");
    }
    let stdout;
    try {
      ({ stdout } = await execFileAsync(this.codexCommand, ["queue", "--thread", threadId, "--message", text], {
        env: this.env, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 32_768,
      }));
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("找不到本机 Codex 命令，无法排队。");
      throw rpcTransportError("CODEX_QUEUE_UNCERTAIN", "queue", "Codex 排队结果待确认");
    }
    const receipt = /^Queued message ([0-9a-f-]+) for thread ([0-9a-f-]+)\.[ \t\r]*$/im.exec(stdout);
    if (!receipt || receipt[2] !== threadId) {
      throw rpcTransportError("CODEX_QUEUE_UNCERTAIN", "queue", "Codex 没有返回可核对的排队回执");
    }
    return receipt[1];
  }

  async resumeThread({ threadId, excludeTurns }) {
    const normalizedThreadId = normalizeNonEmptyString(threadId);
    if (!normalizedThreadId) {
      throw new Error("thread/resume requires a non-empty threadId");
    }
    return this.sendRequest("thread/resume", { threadId: normalizedThreadId, excludeTurns });
  }

  async listThreads({ cursor = null, limit = 100, sortKey = "updated_at", sortDirection, sourceKinds, modelProviders, cwd } = {}) {
    return this.sendRequest("thread/list", {
      ...buildListThreadsParams({ cursor, limit, sortKey }),
      sortDirection,
      sourceKinds,
      modelProviders,
      cwd,
    });
  }

  async listModels() {
    return this.sendRequest("model/list", {});
  }

  async sendRequest(method, params, { timeoutMs = this.timeoutMs, observeTimeout = true } = {}) {
    const id = createRequestId();
    const payload = JSON.stringify({ id, method, params });

    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (observeTimeout) this.lastRpcTimeoutAt = Date.now();
        this.rejectPending(id, rpcTransportError("CODEX_RPC_TIMEOUT", method, "Codex 请求超时"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });

    logCodexOutboundMessage(`request:${method}`);
    try {
      this.sendRaw(payload);
    } catch (error) {
      this.rejectPending(id, error);
    }
    return responsePromise;
  }

  async sendNotification(method, params) {
    const payload = JSON.stringify({ method, params });
    logCodexOutboundMessage(`notification:${method}`);
    this.sendRaw(payload);
  }

  async sendResponse(id, result) {
    const payload = JSON.stringify({ id, result });
    logCodexOutboundMessage("response");
    this.sendRaw(payload);
  }

  sendRaw(payload) {
    if (this.mode === "websocket") {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        throw new Error("Codex websocket is not connected");
      }
      this.socket.send(payload);
      return;
    }

    if (!this.child || !this.child.stdin.writable) {
      throw new Error("Codex process stdin is not writable");
    }
    this.child.stdin.write(`${payload}\n`);
  }

  handleIncoming(rawMessage) {
    const parsed = tryParseJson(rawMessage);
    if (!parsed) {
      console.warn("[codex-wechat] codex<= [parse_failed]");
      return;
    }
    logCodexInboundMessage(parsed);

    if (parsed && parsed.id != null && this.pending.has(String(parsed.id))) {
      this.lastRpcResponseAt = Date.now();
      const { resolve, reject } = this.pending.get(String(parsed.id));
      clearTimeout(this.pending.get(String(parsed.id)).timer);
      this.pending.delete(String(parsed.id));
      if (parsed.error) {
        reject(new Error(parsed.error.message || "Codex RPC request failed"));
        return;
      }
      resolve(parsed);
      return;
    }

    for (const listener of this.messageListeners) {
      listener(parsed);
    }
  }
}

function rpcTransportError(code, method, message) {
  return Object.assign(new Error(message), { code, rpcMethod: method });
}

function createRequestId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function tryParseJson(rawMessage) {
  try {
    return JSON.parse(rawMessage);
  } catch {
    return null;
  }
}

function logCodexOutboundMessage(operation) {
  console.log(`[codex-wechat] codex=> op=${operation}`);
}

function logCodexInboundMessage(message) {
  if (message.method === "turn/completed") {
    const event = { method: message.method, params: { turn: { status: message.params?.turn?.status } } };
    console.log(`[codex-wechat] codex<= ${JSON.stringify(event)}`);
  }
}

function resolveDefaultCodexCommand(env = process.env) {
  return normalizeNonEmptyString(env.CODEX_WECHAT_CODEX_COMMAND) || DEFAULT_CODEX_COMMAND;
}

function buildCodexCommandCandidates(configuredCommand) {
  const explicit = normalizeNonEmptyString(configuredCommand);
  if (explicit) {
    if (!IS_WINDOWS) {
      return [explicit];
    }

    const candidates = [explicit];
    if (!WINDOWS_EXECUTABLE_SUFFIX_RE.test(explicit)) {
      candidates.push(`${explicit}.cmd`, `${explicit}.exe`, `${explicit}.bat`);
    }
    return [...new Set(candidates)];
  }

  if (IS_WINDOWS) {
    return [DEFAULT_CODEX_COMMAND, `${DEFAULT_CODEX_COMMAND}.cmd`, `${DEFAULT_CODEX_COMMAND}.exe`, `${DEFAULT_CODEX_COMMAND}.bat`];
  }

  return [DEFAULT_CODEX_COMMAND];
}

function buildSpawnSpec(command) {
  if (IS_WINDOWS) {
    return {
      command: "cmd.exe",
      args: ["/c", command, "app-server"],
    };
  }

  return {
    command,
    args: ["app-server"],
  };
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function buildStartThreadParams(cwd) {
  const normalizedCwd = normalizeNonEmptyString(cwd);
  return { ...(normalizedCwd && { cwd: normalizedCwd }), ephemeral: false };
}

function buildListThreadsParams({ cursor, limit, sortKey }) {
  const params = { limit, sortKey };
  const normalizedCursor = normalizeNonEmptyString(cursor);

  if (normalizedCursor) {
    params.cursor = normalizedCursor;
  } else if (cursor != null) {
    params.cursor = cursor;
  }

  return params;
}

function buildTurnInputPayload(text) {
  const normalizedText = normalizeNonEmptyString(text);
  const items = [];

  if (normalizedText) {
    items.push({
      type: "text",
      text: normalizedText,
    });
  }

  return items;
}

function buildTurnStartParams({ threadId, input, model, effort, accessMode, workspaceRoot }) {
  const params = { threadId, input };
  const normalizedModel = normalizeNonEmptyString(model);
  const normalizedEffort = normalizeNonEmptyString(effort);
  const normalizedAccessMode = normalizeAccessMode(accessMode);
  const executionPolicies = accessMode === "read-only"
    ? { approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } }
    : buildExecutionPolicies(normalizedAccessMode, workspaceRoot);
  if (normalizedModel) {
    params.model = normalizedModel;
  }
  if (normalizedEffort) {
    params.effort = normalizedEffort;
  }
  if (normalizedAccessMode) {
    params.accessMode = normalizedAccessMode;
  }
  params.approvalPolicy = executionPolicies.approvalPolicy;
  params.sandboxPolicy = executionPolicies.sandboxPolicy;
  return params;
}

function normalizeAccessMode(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "default") {
    return "current";
  }
  return normalized === "full-access" ? normalized : "";
}

function buildExecutionPolicies(accessMode, workspaceRoot) {
  if (accessMode === "full-access") {
    return {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  const normalizedWorkspaceRoot = normalizeNonEmptyString(workspaceRoot);
  const sandboxPolicy = normalizedWorkspaceRoot
    ? {
      type: "workspaceWrite",
      writableRoots: [normalizedWorkspaceRoot],
      networkAccess: true,
    }
    : {
      type: "workspaceWrite",
      networkAccess: true,
    };
  return {
    approvalPolicy: "on-request",
    sandboxPolicy,
  };
}

module.exports = { CodexRpcClient };
