const path = require("node:path");

const { extractRecentConversation } = require("../infra/codex/message-utils");
const { redactSensitiveText } = require("../infra/weixin/redact");
const { extractCommandArgument } = require("../shared/command-parsing");
const { isAbsoluteWorkspacePath, normalizeWorkspacePath } = require("../shared/workspace-paths");
const { readTaskProcess, processHighlights } = require("./task-process");

const MAX_CHOICES = 8;
const CHINESE_NUMBERS = "一二三四五六七八九十";

class TaskManager {
  constructor(runtime, model) {
    this.runtime = runtime;
    this.model = model;
    this.choices = new Map();
    this.handoffs = new Map();
    this.progressQuestions = new Set();
    this.summaries = 0;
  }

  async handle(message) {
    const { runtime } = this;
    if (await runtime.handleLocalCommand(message)) return true;
    if (runtime.config.agentManager && !runtime.config.allowedUserIds?.includes(message.senderId)) {
      await runtime.sendReplyToNormalized(message, "任务总管需要先配置允许使用的微信账号。");
      return true;
    }
    const ordinary = !message.command || message.command === "message";
    if (message.inboxId && !runtime.codex.isReady && message.command !== "workspace"
      && !(runtime.config.agentManager && ordinary)) return this.backendUnavailable(message);
    const key = runtime.sessionStore.buildBindingKey(message);
    const creation = runtime.sessionStore.getPendingSessionCreation(key);
    if (["bind", "new", "switch", "use", "remove", "sessions"].includes(message.command)) this.clearPendingActions(key);
    if (await runtime.dispatchTextCommand(message)) return true;

    if (ordinary && creation?.cwd && /^(?:确认新建|新建(?:会话)?|另开(?:一条)?|可以|好(?:的)?|是)[。！!]*$/.test(message.text.trim())) {
      return this.confirmCreation(message, key, creation);
    }
    if (ordinary && creation && /^(?:不新建|不要新建|不用新建|暂不新建|先不建)[。！!]*$/.test(message.text.trim())) {
      runtime.sessionStore.setPendingSessionCreation(key, null);
      await runtime.sendReplyToNormalized(message, "已取消新建。");
      return true;
    }
    if (/^(?:取消|算了|先不做了|不用继续)[。！!]*$/.test(message.text)
      && (creation || this.choices.has(key) || this.handoffs.has(key) || this.progressQuestions.has(key) || runtime.sessionStore.getPendingInvestigation(key))) {
      this.clearPendingActions(key);
      await runtime.sendReplyToNormalized(message, "已取消等待你回复的操作。");
      return true;
    }
    let intent = parseIntent(message);
    if (intent?.type === "choose" && !intent.explicit && !this.getChoices(key)?.sessions.length) intent = null;
    if (runtime.config.agentManager && ordinary && !["choose", "confirm", "next_page", "watch_list", "unwatch"].includes(intent?.type)) {
      intent = await this.planMessage(message, key, intent);
    } else if (!intent && this.model.enabled && looksLikeManagement(message.text) && runtime.config.allowedUserIds?.includes(message.senderId)) {
      intent = await this.model.classify(message.text).catch(() => ({ type: "clarify" }));
    }
    if (!intent || intent.type === "task") {
      this.clearPendingActions(key);
      return false;
    }
    if (message.inboxId && !runtime.codex.isReady && !["reply", "clarify", "watch_list", "unwatch"].includes(intent.type)) return this.backendUnavailable(message);
    if (intent.type === "confirm_create") return this.confirmCreation(message, key, creation);
    if (intent.type === "creation_project") {
      if (creation && !creation.cwd && intent.project) {
        this.clearPendingActions(key);
        await this.resolveProjectTask({ ...message, ...creation.original }, { ...creation.intent, project: intent.project }, creation.intent.newSession);
      } else {
        await runtime.sendReplyToNormalized(message, "没有等待补充项目的请求。请告诉我想做什么。");
      }
      return true;
    }
    if (!intent.choiceIndex && !["choose", "confirm", "next_page", "reply", "clarify", "watch_list", "unwatch"].includes(intent.type)) {
      this.clearPendingActions(key);
    }

    switch (intent.type) {
      case "list":
        await runtime.handleSessionsCommand({ ...message, text: "/codex sessions" });
        break;
      case "next_page": {
        const choice = this.getChoices(key);
        if (choice?.intent.nextPage) {
          await runtime.handleSessionsCommand({ ...message, text: `/codex sessions ${choice.intent.nextPage}` });
        } else {
          await runtime.sendReplyToNormalized(message, "没有可翻到的下一页。可以说「列出会话」重新查看。");
        }
        break;
      }
      case "history":
        await runtime.handleMessageCommand(message);
        break;
      case "select":
      case "status":
      case "summary":
      case "inspect":
      case "investigate":
      case "dispatch":
      case "create":
        await this.resolveTarget(message, intent);
        break;
      case "watch":
        if (intent.choiceIndex) await this.choose(message, key, intent.choiceIndex, intent);
        else await this.watchProjects(message, intent);
        break;
      case "watch_list":
      case "unwatch":
        await this.manageWatches(message, intent);
        break;
      case "choose":
        await this.choose(message, key, intent.index, intent.view ? { type: "status", report: true } : null);
        break;
      case "confirm":
        await this.confirm(message, key);
        break;
      case "reply":
      case "clarify":
      default:
        if (intent.pendingInvestigation) runtime.sessionStore.setPendingInvestigation(key, {
          assignment: intent.assignment,
        });
        await runtime.sendReplyToNormalized(message, intent.reply || "你想查找、总结或查证哪条会话，还是要给它派活？请补充项目名或要做的事。");
    }
    return true;
  }

  async backendUnavailable(message) {
    await this.runtime.sendReplyToNormalized(message, "微信桥接在线，Codex 暂不可用。请稍后重试。");
    return true;
  }

  clearPendingActions(key) {
    this.choices.delete(key);
    this.handoffs.delete(key);
    this.progressQuestions.delete(key);
    if (this.runtime.sessionStore.getPendingInvestigation(key)) this.runtime.sessionStore.setPendingInvestigation(key, null);
    if (this.runtime.sessionStore.getPendingSessionCreation(key)) this.runtime.sessionStore.setPendingSessionCreation(key, null);
  }

  async planMessage(message, key, directIntent) {
    const selected = this.runtime.getCurrentThreadContext(message);
    const previous = this.runtime.sessionStore.getManagerTarget(key);
    const pendingInvestigation = this.runtime.sessionStore.getPendingInvestigation(key);
    const creation = this.runtime.sessionStore.getPendingSessionCreation(key);
    try {
      const plan = await this.model.plan({
        text: message.text,
        conversation: this.managerConversation(key),
        context: {
          previous: previous ? { project: path.basename(previous.cwd), title: previous.title, task: previous.task } : null,
          pendingInvestigation,
          pendingCreation: creation ? { needProject: !creation.cwd, project: creation.intent.project,
            objective: creation.intent.assignment?.objective, title: creation.intent.title } : null,
          selected: selected.threadId ? { project: path.basename(selected.workspaceRoot) } : null,
          pendingAction: this.progressQuestions.has(key) ? "status" : null,
          watches: (this.runtime.taskWatches?.list(message.senderId) || []).slice(0, 10).map(({ title, cwd }) => ({
            title, project: path.basename(cwd),
          })),
          choices: (this.getChoices(key)?.sessions || []).map((session, index) => ({
            index: index + 1, title: sessionLabel(session), project: path.basename(session.cwd),
          })),
        },
        attachments: (message.attachments || []).slice(0, 8).map(({ kind, fileName }) => ({ kind, name: fileName?.slice(0, 150) })),
      });
      if (pendingInvestigation && /^[a-z][a-z0-9_.-]{0,59}$/i.test(message.text.trim()) && plan.query) {
        return { ...plan, ...pendingInvestigation, type: "investigate", agent: true, report: true };
      }
      if (directIntent?.contextTarget === "recent") return directIntent;
      if (plan.type === "dispatch" && ["list", "history", "status", "summary"].includes(directIntent?.type)) return directIntent;
      return { ...plan, agent: true, report: ["status", "summary", "inspect", "investigate"].includes(plan.type) };
    } catch {
      if (["list", "history", "status", "summary"].includes(directIntent?.type)) return directIntent;
      return { type: "clarify", reply: "任务总管暂时无法判断这条消息。请稍后重试，或用明确的会话命令。" };
    }
  }

  managerConversation(key) {
    const { sessionStore } = this.runtime;
    return { threadId: sessionStore.getManagerThread(key), saveThreadId: (id) => sessionStore.setManagerThread(key, id) };
  }

  async watchProjects(message, intent) {
    const { runtime } = this;
    const watcher = runtime.taskWatches;
    if (!watcher) return runtime.sendReplyToNormalized(message, "监听服务暂不可用。");
    const roots = await runtime.getSessionManagerRoots(message);
    const key = runtime.sessionStore.buildBindingKey(message);
    const previous = intent.contextTarget === "previous" ? runtime.sessionStore.getManagerTarget(key) : null;
    const selected = intent.contextTarget === "selected" ? runtime.getCurrentThreadContext(message).threadId : null;
    const targets = [...new Set(intent.watchTargets?.length ? intent.watchTargets
      : [intent.query || previous?.id || selected].filter(Boolean))].filter((target) => target !== "*");
    if (!targets.length) return runtime.sendReplyToNormalized(message, "你想盯哪些项目或会话？可以一次告诉我多个。");
    const matches = new Map(targets.map((target) => [target, []]));
    for await (const session of runtime.listManagedSessions(roots)) {
      for (const [target, sessions] of matches) {
        if (session.id === target) {
          matches.set(target, [session]);
        } else if (!sessions.some(({ id }) => id === target) && matchesSession(session, target, true)
          && (sessions.length < MAX_CHOICES || (session.status === "active" && sessions.length < 2 * MAX_CHOICES))) {
          sessions.push(session);
        }
      }
    }
    const inspected = new Map();
    const unique = [...new Map([...matches.values()].flat().map((session) => [session.id, session])).values()];
    for (let index = 0; index < unique.length; index += 4) {
      await Promise.all(unique.slice(index, index + 4).map(async (session) => {
        try {
          inspected.set(session.id, await watcher.inspect(session));
        } catch {
          inspected.set(session.id, undefined);
        }
      }));
    }
    const lines = [];
    const registered = new Set();
    let offeredChoices = false;
    for (const [target, sessions] of matches) {
      const active = sessions.filter(({ id }) => inspected.get(id));
      if (!active.length) {
        const checkFailed = sessions.some(({ id }) => inspected.get(id) === undefined);
        lines.push(checkFailed ? `「${target}」暂时读不到运行记录。`
          : `「${target}」的匹配会话里暂未找到可监听的当前任务。`);
        continue;
      }
      if (new Set(active.map(({ cwd }) => cwd)).size > 1) {
        if (offeredChoices) {
          lines.push(`「${target}」也匹配多个项目。可用会话标题或 ID 指定。`);
          continue;
        }
        offeredChoices = true;
        const choices = active.slice(0, MAX_CHOICES);
        this.rememberChoices(message, choices, { type: "watch" });
        lines.push(`「${target}」匹配多个项目，请回复对应编号。`,
          ...choices.map((session, index) => `${index + 1}. ${sessionLabel(session)} · ${path.basename(session.cwd)}`));
        continue;
      }
      for (const session of active) {
        if (registered.has(session.id)) continue;
        await runtime.requireManagedWorkspace(session.cwd, roots);
        const turn = inspected.get(session.id);
        const label = sessionLabel(session);
        const result = await watcher.register(message, session, label, turn);
        registered.add(session.id);
        lines.push(result === "added" ? `已监听「${label}」的当前任务。` : `「${label}」已在监听中。`);
      }
    }
    await runtime.sendReplyToNormalized(message, lines.join("\n"));
  }

  async manageWatches(message, intent) {
    const { runtime } = this;
    const watcher = runtime.taskWatches;
    if (!watcher) return runtime.sendReplyToNormalized(message, "监听服务暂不可用。");
    if (intent.type === "watch_list") {
      const watches = watcher.list(message.senderId);
      return runtime.sendReplyToNormalized(message, watches.length ? ["正在监听",
        ...watches.map(({ title, cwd }, index) => `${index + 1}. ${title} · ${path.basename(cwd)}`)].join("\n") : "目前没有正在监听的任务。");
    }
    const targets = intent.watchTargets?.length ? intent.watchTargets : [intent.query].filter(Boolean);
    const all = targets.includes("*") && /全部|所有|都|\ball\b/i.test(message.text);
    const { stopped, withdrawn } = watcher.cancel(message.senderId, (watch) => all
      || targets.some((target) => target === watch.thread || matchesSession({ ...watch, id: watch.thread || "" }, target, true)));
    const lines = [];
    if (stopped.length) lines.push(`已停止监听 ${stopped.map(({ title }) => `「${title}」`).join("、")}。`);
    if (withdrawn) lines.push(`已撤销 ${withdrawn} 条待发送的监听消息。`);
    return runtime.sendReplyToNormalized(message, lines.join("\n")
      || "没有找到要停止的监听。可以说「正在盯哪些任务」查看。");
  }

  rememberChoices(message, sessions, intent = { type: "select" }) {
    const key = this.runtime.sessionStore.buildBindingKey(message);
    this.runtime.sessionStore.setManagerList(key, {
      sessions: sessions.map(({ id, cwd, title }) => ({ id, cwd, title })),
      intent: { type: "select", nextPage: intent.nextPage ?? null },
    });
    if (intent.type === "select" && Object.hasOwn(intent, "nextPage")) {
      this.choices.delete(key);
      return;
    }
    this.choices.set(key, { sessions, intent, original: message });
  }

  getChoices(key) {
    return this.choices.get(key) || this.runtime.sessionStore.getManagerList(key);
  }

  async choose(message, key, index, override) {
    const choice = this.getChoices(key);
    const session = choice?.sessions[index - 1];
    if (!session) {
      await this.runtime.sendReplyToNormalized(message, "上一份列表里找不到这个编号。请说「列出会话」或重新描述目标。");
      return;
    }
    const original = override ? message : (choice.original || message);
    if (this.runtime.sessionStore.getPendingSessionCreation(key)) this.runtime.sessionStore.setPendingSessionCreation(key, null);
    try {
      await this.applyIntent({ ...original, inboxId: message.inboxId, contextToken: message.contextToken },
        override || choice.intent, session.id, session.cwd);
    } catch (error) {
      if (error.code !== "SESSION_UNAVAILABLE") throw error;
      await this.runtime.sendReplyToNormalized(message, "刚才列表里的这条会话已不可用。请说「列出会话」刷新列表。");
    }
    if (!override) this.choices.delete(key);
  }

  async resolveTarget(message, intent) {
    const { runtime } = this;
    if (intent.choiceIndex) {
      await this.choose(message, runtime.sessionStore.buildBindingKey(message), intent.choiceIndex, intent);
      return;
    }
    const creationPolicy = ["create", "dispatch", "investigate"].includes(intent.type) ? intent.newSession : "reuse";
    if (creationPolicy === "explicit" || (["if_missing", "ask"].includes(creationPolicy)
      && !["previous", "selected"].includes(intent.contextTarget))) {
      await this.resolveProjectTask(message, intent, creationPolicy);
      return;
    }
    if (!intent.query) {
      await this.resolveContextTarget(message, intent);
      return;
    }
    const roots = await runtime.getSessionManagerRoots(message);
    const sessions = [];
    const reportedProjects = new Set();
    for await (const session of runtime.listManagedSessions(roots)) {
      if (session.id === intent.query) return this.applyIntent(message, intent, session.id, session.cwd);
      if (!matchesSession(session, intent.query, intent.report || intent.agent)) continue;
      if (intent.report && reportedProjects.has(session.cwd)) continue;
      if (intent.report) reportedProjects.add(session.cwd);
      if (sessions.length < MAX_CHOICES + 1) sessions.push(session);
    }
    if (sessions.length === 1) return this.applyIntent(message, intent, sessions[0].id, sessions[0].cwd);
    if (!sessions.length) {
      await runtime.sendReplyToNormalized(message, "没找到匹配的会话。请补充项目名、标题关键词或会话 ID。");
      return;
    }
    const choices = sessions.slice(0, MAX_CHOICES);
    this.rememberChoices(message, choices, intent);
    const lines = choices.map((session, index) => `${index + 1}. ${sessionLabel(session)} · ${path.basename(session.cwd)}`);
    if (sessions.length > MAX_CHOICES) lines.push("还有更多匹配，可以补充关键词缩小范围。");
    await runtime.sendReplyToNormalized(message, ["找到多条会话。请回复编号。", ...lines].join("\n"));
  }

  async resolveProjectTask(message, intent, policy) {
    const { runtime } = this;
    if (!intent.assignment && intent.type !== "create") {
      await runtime.sendReplyToNormalized(message, "还没有整理出可执行的任务单，请补充任务目标和范围。");
      return;
    }
    const roots = await runtime.getSessionManagerRoots(message);
    const project = intent.project || (policy === "explicit" ? intent.query : "");
    const workspace = normalizeWorkspacePath(project);
    const explicitPath = isAbsoluteWorkspacePath(workspace) && message.text.includes(project);
    const key = runtime.sessionStore.buildBindingKey(message);
    const knownRoots = [runtime.config.defaultWorkspaceRoot, ...roots, ...runtime.sessionStore.listWorkspaceRoots(key)].filter(Boolean);
    const workspaces = new Set(knownRoots.filter((cwd) => projectMatches(cwd, project, explicitPath)));
    const aliases = new Set();
    if (explicitPath) workspaces.add(workspace);
    if (!project && policy === "explicit" && intent.contextTarget !== "none") {
      const target = intent.contextTarget === "previous" ? runtime.sessionStore.getManagerTarget(key) : runtime.getCurrentThreadContext(message);
      if (target?.cwd || target?.workspaceRoot) workspaces.add(target.cwd || target.workspaceRoot);
    }

    const query = intent.query || project;
    const exactId = /^[a-f0-9-]{36}$/i.test(query);
    const sessions = [];
    const related = new Map();
    for await (const session of runtime.listManagedSessions(roots)) {
      if (policy !== "explicit" && session.id === query) return this.applyIntent(message, intent, session.id, session.cwd);
      if (policy !== "explicit") {
        const group = related.get(session.cwd) || [];
        if (group.length <= MAX_CHOICES) group.push(session);
        related.set(session.cwd, group);
      }
      if (!project || exactId && policy !== "explicit") continue;
      if (projectMatches(session.cwd, project, explicitPath)) workspaces.add(session.cwd);
      else if (!isAbsoluteWorkspacePath(workspace) && matchesSession(session, project, true)) aliases.add(session.cwd);
      else continue;
      if (policy !== "explicit" && sessions.length <= MAX_CHOICES
        && ((query === project && projectMatches(session.cwd, project, explicitPath)) || matchesSession(session, query, true))) sessions.push(session);
    }
    if (exactId && policy !== "explicit") {
      await runtime.sendReplyToNormalized(message, "没有找到这条可见会话。请核对会话 ID。");
      return;
    }
    const workspacePaths = await Promise.all([...(workspaces.size ? workspaces : aliases)]
      .map(async (root) => [root, await runtime.resolveManagedSessionWorkspace(root, roots)]));
    const candidates = new Set(workspacePaths.map(([, root]) => root).filter(Boolean));
    const cwd = candidates.size === 1 ? [...candidates][0] : "";
    if (cwd && policy !== "explicit" && !sessions.length) {
      const nearby = workspacePaths.filter(([, root]) => root === cwd).flatMap(([root]) => related.get(root) || [])
        .sort((a, b) => b.updatedAt - a.updatedAt);
      if (nearby.length && policy === "if_missing") {
        const reviewed = nearby.slice(0, MAX_CHOICES);
        let result;
        try {
          result = await this.model.chooseSession({ assignment: intent.assignment,
            candidates: reviewed.map(sessionLabel), conversation: this.managerConversation(key) });
        } catch {
          result = { decision: "ask" };
        }
        if (result.decision === "reuse") {
          const session = reviewed[result.index - 1];
          return this.applyIntent(message, intent, session.id, session.cwd);
        }
        if (result.decision !== "create" || nearby.length > reviewed.length) policy = "ask";
      }
      if (policy === "ask") sessions.push(...nearby.slice(0, MAX_CHOICES));
    }
    if (sessions.length === 1 && (policy !== "ask" || !cwd)) {
      return this.applyIntent(message, intent, sessions[0].id, sessions[0].cwd);
    }
    if (sessions.length) {
      const choices = sessions.slice(0, MAX_CHOICES);
      this.rememberChoices(message, choices, intent);
      if (cwd && policy === "ask") this.rememberCreation(message, intent, cwd);
      const lines = choices.map((session, index) => `${index + 1}. ${sessionLabel(session)}`);
      await runtime.sendReplyToNormalized(message, ["找到可能合适的会话。要复用的话，请回复编号。",
        ...lines, cwd && policy === "ask" ? "如果这次要单独做，也可以回复「新建会话」。" : ""].filter(Boolean).join("\n"));
      return;
    }
    if (!cwd) {
      this.rememberCreation(message, intent, "");
      await runtime.sendReplyToNormalized(message, candidates.size
        ? "找到多个同名项目。你希望在哪个项目目录创建会话？请发完整目录。"
        : "还没找到任务对应的项目。请告诉我项目名或本机项目的完整目录。");
      return;
    }
    if (policy === "ask" || (policy === "if_missing" && !intent.query)) {
      this.rememberCreation(message, intent, cwd);
      await runtime.sendReplyToNormalized(message, `没找到可明确复用的会话。要在「${path.basename(cwd)}」新建一条来做「${intent.assignment.objective}」吗？可以回复「新建会话」，也可以告诉我想复用哪条。`);
      return;
    }
    await this.createSession(message, intent, cwd);
  }

  rememberCreation(message, intent, cwd) {
    const { runtime } = this;
    const { attachments, messageId, receivedAt } = message;
    runtime.sessionStore.setPendingSessionCreation(runtime.sessionStore.buildBindingKey(message), {
      intent, cwd, original: { attachments, messageId, receivedAt },
    });
  }

  async confirmCreation(message, key, creation) {
    if (!creation?.cwd) {
      await this.runtime.sendReplyToNormalized(message, creation ? "请先告诉我在哪个项目里新建。" : "目前没有待确认的新建请求。");
      return true;
    }
    if (message.inboxId && !this.runtime.codex.isReady) return this.backendUnavailable(message);
    this.clearPendingActions(key);
    await this.createSession({ ...message, ...creation.original }, creation.intent, creation.cwd);
    return true;
  }

  async createSession(message, intent, cwd) {
    const title = intent.title || intent.assignment?.objective || `${path.basename(cwd)} 新会话`;
    const assignment = intent.assignment ? assignmentMessage(message, intent) : {
      ...message, text: "此会话已创建，等待后续任务。请只回复「会话已就绪」，无需执行其他操作。", readOnly: true,
    };
    await this.runtime.createManagedSession({ ...assignment, newSessionTitle: title.replace(/\s+/g, " ").slice(0, 80) }, cwd);
  }

  async resolveContextTarget(message, intent) {
    const { runtime } = this;
    const key = runtime.sessionStore.buildBindingKey(message);
    const previous = runtime.sessionStore.getManagerTarget(key);
    let target = ["previous", "recent"].includes(intent.contextTarget) ? previous : null;
    if (!target && (intent.contextTarget === "selected" || intent.contextTarget === "recent" || (!intent.agent && intent.type !== "select"))) {
      const context = runtime.getCurrentThreadContext(message);
      if (context.threadId) target = { id: context.threadId, cwd: context.workspaceRoot };
    }
    const question = intent.type === "status" ? "你想看哪个项目或会话的进度？" : "你想操作哪个项目或会话？";
    if (!target) {
      if (intent.type === "status") this.progressQuestions.add(key);
      await runtime.sendReplyToNormalized(message, question);
      return;
    }
    try {
      await this.applyIntent(message, intent, target.id, target.cwd);
    } catch (error) {
      if (error.code !== "SESSION_UNAVAILABLE") throw error;
      if (message.inboxId) logRoute(message, "unavailable", intent.type, target.id);
      if (previous?.id === target.id) runtime.sessionStore.setManagerTarget(key, null);
      if (intent.type === "status") this.progressQuestions.add(key);
      await runtime.sendReplyToNormalized(message, `上次关联的会话已归档或不可用。${question}`);
    }
  }

  async applyIntent(message, intent, id, workspaceRoot) {
    if (intent.type === "watch") {
      return this.watchProjects(message, { watchTargets: [id] });
    }
    const { runtime } = this;
    if (message.inboxId) logRoute(message, "target", intent.type, id);
    const thread = await runtime.readSelectedThread(id, workspaceRoot);
    const roots = await runtime.getSessionManagerRoots(message);
    await runtime.requireManagedWorkspace(thread.cwd, roots);
    const label = sessionLabel(thread);
    const key = runtime.sessionStore.buildBindingKey(message);
    const previous = runtime.sessionStore.getManagerTarget(key);
    const task = intent.assignment?.objective || (previous?.id === thread.id ? previous.task : undefined);
    runtime.sessionStore.setManagerTarget(key, { id: thread.id, cwd: thread.cwd, title: label, task });

    if (intent.type === "status") {
      this.progressQuestions.delete(key);
      const updated = thread.updatedAt ? new Date(thread.updatedAt * 1_000).toLocaleString() : "未知";
      const desktop = thread.status?.type === "notLoaded" ? "\n当前是否运行，以 Codex App 为准。" : "";
      const status = `${await runtime.sessionStatusLabel(thread)}。\n最近更新: ${updated}${desktop}`;
      if (intent.report) {
        await this.startSummary(message, thread, label, { status, recent: true });
      } else {
        await runtime.sendReplyToNormalized(message, `「${label}」${status}`);
      }
      return;
    }
    if (intent.type === "summary" || intent.type === "inspect") {
      await this.startSummary(message, thread, label, { inspect: intent.type === "inspect", recent: intent.report });
      return;
    }
    if (intent.type === "dispatch" || intent.type === "investigate") {
      if (!intent.assignment) {
        await runtime.sendReplyToNormalized(message, "还没有整理出可执行的任务单，请补充任务目标和范围。");
        return;
      }
      await runtime.routeUserMessage(assignmentMessage(message, intent), undefined, thread);
      return;
    }

    this.handoffs.delete(key);
    runtime.selectManagedThread(message, thread);
    await runtime.sendReplyToNormalized(message, `已选中「${label}」· ${path.basename(thread.cwd)}。后续任务会发到这条会话。`);
    if (intent.followup) await runtime.routeUserMessage({ ...message, text: intent.followup });
  }

  async requestHandoff(message, thread, target) {
    const key = this.runtime.sessionStore.buildBindingKey(message);
    this.handoffs.set(key, { message, id: thread.id, target });
    const task = message.taskLabel ? `\n待派任务：${message.taskLabel}` : "";
    const instruction = target
      ? "目前无法确认这条会话由哪个客户端持有。可以在 Codex App 打开原会话后重发；若要移交给共享服务，请先确认原会话已释放，再回复「确认移交」。"
      : "要续接，请先在 Codex App 确认原任务已结束并关闭会话，再回复「确认继续」。";
    await this.runtime.sendReplyToNormalized(message, `「${sessionLabel(thread)}」\n${instruction}${task}`);
  }

  async confirm(message, key) {
    const handoff = this.handoffs.get(key);
    if (!handoff) {
      await this.runtime.sendReplyToNormalized(message, "没有可确认的续接请求。请重新发送任务。");
      return;
    }
    this.handoffs.delete(key);
    await this.runtime.routeUserMessage({
      ...handoff.message, contextToken: message.contextToken, inboxId: message.inboxId,
    }, handoff.id, handoff.target);
  }

  async startSummary(message, thread, label, options = {}) {
    const { runtime } = this;
    if (this.summaries >= 2) {
      await runtime.sendReplyToNormalized(message, "已有两条总结在处理，请稍后再试。");
      return;
    }
    this.summaries += 1;
    try {
      await runtime.sendReplyToNormalized(message, `正在读取「${label}」的任务结果。`);
      if (message.inboxId) runtime.messageStore.waitForResult(message.inboxId);
    } catch (error) {
      this.summaries -= 1;
      throw error;
    }
    void this.summarize(message, thread, label, options).catch((error) => {
      console.error(`[codex-wechat] summary delivery: ${error.message}`);
    }).finally(() => { this.summaries -= 1; });
  }

  async summarize(message, thread, label, { status = "", recent = false, inspect = false }) {
    const { runtime } = this;
    let reply;
    try {
      const process = recent && !inspect;
      const watched = process && this.runtime.taskWatches?.list(message.senderId).findLast(({ thread: id }) => id === thread.id);
      const { messages, truncated } = process ? await readTaskProcess(runtime.codex, thread.id, watched?.turn)
        : { messages: await this.readSummaryMessages(thread.id, { recent, inspect }) };
      const partial = thread.status?.type !== "idle";
      if (!messages.length) {
        reply = "这轮目前没有查到可总结的过程记录。";
      } else if (this.model.enabled) {
        reply = await this.model.summarize({ messages, focus: message.text, partial, inspect, process }).catch((error) => {
          if (!status && !process) throw error;
          return recordedProgress(messages);
        });
      } else {
        const latest = messages.findLast((item) => item.role === "assistant");
        if (status || process) {
          reply = recordedProgress(messages);
        } else {
          reply = latest ? `总结模型尚未配置。最近一条原结果如下。\n\n${latest.text.slice(0, 3_000)}` : "总结模型尚未配置，且历史里还没有助手结果。";
        }
      }
      if (truncated) reply += "\n\n本次汇总依据可读取的近期记录，早期过程可能未覆盖。";
      if (partial && !status) reply = "截至目前\n" + reply;
    } catch {
      reply = status ? "暂时读不到这条会话的进展记录，请稍后重试。"
        : "暂时无法生成总结。你可以说「查看当前会话结果」，或稍后重试。";
    }
    await runtime.sendReplyToUser(message.senderId, [`「${label}」`, status, reply].filter(Boolean).join("\n"), message.contextToken, { finishId: message.inboxId });
  }

  async readSummaryMessages(threadId, { recent, inspect }) {
    const { codex } = this.runtime;
    if (recent || inspect) {
      const response = await codex.sendRequest("thread/items/list", { threadId, limit: 24, sortDirection: "desc" });
      const items = (response.result.data || []).map(({ item }) => item).reverse();
      const messages = extractRecentConversation([{ items }]);
      if (inspect) {
        const checks = items.filter((item) => item?.type === "commandExecution").slice(-4);
        for (const check of checks) {
          messages.push({ role: "verification", text: JSON.stringify({
            command: redactSensitiveText(check.command, 350), status: check.status, exitCode: check.exitCode,
            output: redactSensitiveText(String(check.aggregatedOutput || "").slice(-600)),
          }) });
        }
        if (!checks.length) messages.push({ role: "verification", text: "最近的记录中没有查到命令执行证据。" });
      }
      return messages;
    }
    const response = await codex.sendRequest("thread/turns/list", {
      threadId, limit: 3, sortDirection: "desc", itemsView: "full",
    });
    return extractRecentConversation((response.result.data || []).slice().reverse());
  }
}

function logRoute(message, phase, action, threadId) {
  console.log("[codex-wechat] route " + JSON.stringify({ at: new Date().toISOString(), inbox: message.inboxId, phase, action, thread: threadId }));
}

function recordedProgress(messages) {
  const latest = messages.findLast((item) => item.role === "assistant");
  const highlights = processHighlights(messages);
  return highlights ? `关键过程\n${highlights}`
    : latest ? `最近一次进展记录\n${latest.text.slice(0, 800)}${latest.text.length > 800 ? "…" : ""}` : "会话中还没有助手的进展记录。";
}

function parseIntent(message) {
  const text = message.text;
  if (message.command === "summary") {
    return { type: "summary", query: extractCommandArgument(text, "/codex summary ") };
  }
  if (message.command !== "message") return null;
  if (/^(?:请|帮我)?(?:看看|查看|列出)?(?:正在盯哪些任务|正在监听哪些任务|监听列表|我在盯哪些任务)[？?。！!]*$/.test(text)) return { type: "watch_list" };
  if (/^(?:请|帮我)?(?:停止|取消)(?:全部|所有)监听[。！!]*$/.test(text)) return { type: "unwatch", watchTargets: ["*"] };
  if (/^(?:下一页|看下一页|翻页)[。！!]*$/.test(text)) return { type: "next_page" };
  if (/^(?:请|帮我)?(?:看看|看一下|查一下|说说|汇报一下)\s*(?:当前|最近|现在的)?(?:进度|进展)[？?。！!]*$/.test(text)) {
    return { type: "status", query: "", contextTarget: "recent", report: true, agent: true };
  }
  if (/^(?:查看|看看)(?:当前|刚才)(?:会话|任务)(?:的)?结果[？?。]*$/.test(text)) return { type: "history" };
  if (/^(?:确认继续|确认续接|确认移交|原任务已结束)[。！!]*$/.test(text)) return { type: "confirm" };
  const viewChoice = /^(?:我\s*)?(?:想|要)?\s*(?:看看|看一下|查看|看|查一下)\s*(?:列表里(?:的)?\s*)?第\s*([1-9]\d*|[一二三四五六七八九十])\s*(?:个|条)\s*(?:Codex\s*)?(?:任务|会话)?\s*(?:的?\s*(?:进度|状态|进展))?[？?。！!]*$/i.exec(text);
  if (viewChoice) return { type: "choose", index: choiceNumber(viewChoice[1]), explicit: true, view: true };
  const choice = /^(?:选中?|选择|切到)?\s*(?:第\s*)?([1-9]\d*|[一二三四五六七八九十])(?:\s*(?:条|个)\s*(?:任务|会话)?)?[。！!]*$/.exec(text);
  if (choice) return { type: "choose", index: choiceNumber(choice[1]), explicit: /第|条|个|选|切/.test(text) };
  const recentTen = /^(?:(?:你要|请|帮我)\s*)?(?:按(?:照)?时间(?:顺序)?\s*)?(?:列出(?:来)?|看看|查看|显示)?\s*最近的?\s*(?:10|十)\s*(?:个|条)\s*(?:Codex\s*)?(?:会话|任务)[？?。！!]*$/i;
  if (recentTen.test(text) || /^(?:(?:请|帮我|给我|我想)\s*)?(?:列出|看看|查看|显示|我有哪些)(?:我|一下|的|最近|有哪些|可用|所有|本机|Codex|\s)*(?:会话|任务)(?:列表)?[？?。！!]*$/i.test(text)) {
    return { type: "list" };
  }
  const report = /^(?:(.+?)[，,。；;]\s*)?(?:请|给我|帮我)*(?:汇报|报告|说说|告诉我)(?:一下)?\s*(.*?)\s*(?:现在|当前|目前|最新)?的?(?:状态|进度|进展)[？?。！!]*$/s.exec(text);
  if (report) {
    const subject = (report[1] || "").replace(/^我(?:现在|手头)?有(?:一个|一款)?\s*/, "")
      .replace(/\s*(?:正在|还在|在)?开发(?:过程)?中$/, "");
    const query = cleanCurrentReference(report[2]) || cleanCurrentReference(subject);
    return { type: "status", query, report: true };
  }
  const select = /^(?:请|帮我)?(?:切换到|切到|选中|选择|找回)\s*(.+)$/s.exec(text);
  if (select) {
    const [query, ...rest] = select[1].split(/[，,]/);
    const followup = rest.join("，").trim();
    return { type: "select", query, followup: /^(?:请|帮我|顺便)*(?:继续|先|写|改|修|跑|测试|执行|实现|检查)/.test(followup) ? followup : "" };
  }
  if (/^(?:请|帮我)?(?:总结|汇总|概括|归纳)/.test(text)
    && (/会话|任务|结果|进展|刚才|当前|没做完/.test(text) || /^(?:请|帮我)?总结(?:一下)?[。！!]*$/.test(text))) {
    const target = /^(?:请|帮我)?(?:总结|汇总|概括|归纳)(?:一下)?\s*(.+?)\s*的(?:任务)?(?:结果|进展|会话)/.exec(text)?.[1] || "";
    return { type: "summary", query: cleanCurrentReference(target) };
  }
  const status = /^(.+?)(?:还在跑吗|进度怎么样|现在什么状态|状态如何)[？?。]*$/.exec(text);
  if (status) return { type: "status", query: cleanCurrentReference(status[1]) };
  if (/^(?:继续|接着)(?:刚才|上次)(?:那个|那条)?[。！!]*$/.test(text)) return { type: "clarify" };
  return null;
}

function choiceNumber(value) {
  return Number(value) || CHINESE_NUMBERS.indexOf(value) + 1;
}

function cleanCurrentReference(value) {
  return /^(?:|它|当前|刚才|这个|当前会话|当前任务|刚才那条|现在选中)$/.test(value.trim()) ? "" : value.trim();
}

function looksLikeManagement(text) {
  return /会话|任务列表|做完了吗|进展|摘要|汇报.*(?:状态|进度)/.test(text) && !/^(?:请|帮我)?(?:写|改|修|实现|跑|执行|测试|继续修)/.test(text);
}

function assignmentMessage(message, intent) {
  const { objective, scope, constraints, deliverables } = intent.assignment;
  const readOnly = intent.type === "investigate";
  const limits = readOnly ? ["只读排查，不修改文件、配置或项目状态。", ...constraints] : constraints;
  const bullets = (lines) => lines.map((line) => `- ${line}`).join("\n");
  const text = ["请在本会话执行以下任务单。", `任务目标\n${objective}`, `执行范围\n${bullets(scope)}`,
    limits.length ? `约束\n${bullets(limits)}` : "", `回报结果\n${bullets(deliverables)}`].filter(Boolean).join("\n\n");
  return { ...message, text, taskLabel: objective, readOnly };
}

function projectMatches(cwd, project, explicitPath) {
  if (explicitPath) return normalizeWorkspacePath(cwd) === normalizeWorkspacePath(project);
  const canonical = (name) => name.toLowerCase().replace(/[\s_-]+/g, "");
  return Boolean(project) && canonical(path.basename(cwd)) === canonical(project);
}

function matchesSession(session, query, report = false) {
  const search = report ? query.replace(/(?:游戏|软件|程序|应用)/g, " ") : query;
  const tokens = search.toLowerCase().replace(/(?:里的|里|中的|下的|那条|那个|会话|项目|任务|的)/g, " ")
    .split(/[\s，,。!?？、]+/).map((word) => word.replace(/^修复?(?=[\p{Script=Han}])/u, "")).filter(Boolean);
  const haystack = `${session.id} ${session.title} ${normalizeWorkspacePath(session.cwd)}`.toLowerCase();
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function sessionLabel(thread) {
  return (thread.name || thread.title || thread.preview || path.basename(thread.cwd) || thread.id)
    .replace(/\s+/g, " ").slice(0, 80);
}

module.exports = { TaskManager };
