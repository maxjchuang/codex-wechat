const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WechatRuntime } = require("../src/app/wechat-runtime");
const { SessionStore } = require("../src/infra/storage/session-store");

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wechat-sessions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const cwdA = path.join(root, "project-a");
  const cwdB = path.join(root, "project-b");
  const outside = path.join(root, "outside");
  [cwdA, cwdB, outside].forEach((cwd) => fs.mkdirSync(cwd));
  const link = path.join(cwdA, "link");
  fs.symlinkSync(outside, link, "junction");

  const runtime = new WechatRuntime({
    sessionsFile: path.join(root, "bindings.json"),
    accountsDir: path.join(root, "accounts"),
    allowedUserIds: ["owner"],
    workspaceAllowlist: [cwdA, cwdB],
    defaultWorkspaceId: "default",
    defaultCodexAccessMode: "default",
    enableTyping: false,
  });
  runtime.account = { accountId: "account" };

  const sessions = new Map([
    ["thread-a", makeThread("thread-a", cwdA)],
    ["thread-b", makeThread("thread-b", cwdB, "idle")],
    ["thread-outside", makeThread("thread-outside", outside, "idle")],
    ["thread-link", makeThread("thread-link", link, "idle")],
  ]);
  const replies = [];
  const resumed = [];
  const sent = [];
  runtime.sendReplyToUser = async (_recipient, text) => replies.push(text);
  runtime.codex.readThread = async (threadId) => ({ result: { thread: sessions.get(threadId) } });
  runtime.codex.resumeThread = async ({ threadId, excludeTurns }) => {
    assert.equal(excludeTurns, true);
    resumed.push(threadId);
    const thread = sessions.get(threadId);
    thread.status = { type: "idle" };
    return { result: { thread } };
  };
  runtime.codex.sendUserMessage = async (request) => sent.push(request);
  runtime.codex.startThread = async () => assert.fail("Explicit selection must never start a new thread");

  let messageId = 0;
  const receive = async (text, sender = "owner") => {
    await runtime.handleIncomingMessage({
      message_type: 1,
      message_id: ++messageId,
      from_user_id: sender,
      context_token: "test-context",
      item_list: [{ type: 1, text_item: { text } }],
    });
    return replies.at(-1);
  };
  const bindingKey = runtime.sessionStore.buildBindingKey({ workspaceId: "default", accountId: "account", senderId: "owner" });
  return { runtime, cwdA, cwdB, sessions, replies, resumed, sent, receive, bindingKey };
}

function makeThread(id, cwd, status = "notLoaded") {
  return { id, cwd, name: id, source: "appServer", status: { type: status } };
}

test("one manager can add, list, and remove read-only watches across projects", async (t) => {
  const { runtime, sessions, receive, sent, resumed } = makeFixture(t);
  runtime.config.agentManager = true;
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  const watches = [];
  runtime.taskWatches = {
    list: (sender) => watches.filter((watch) => watch.sender === sender),
    inspect: async (session) => ({ id: `turn-${session.id}` }),
    async register(message, session, title, turn) {
      watches.push({ id: session.id, thread: session.id, sender: message.senderId, cwd: session.cwd, title, turn: turn.id });
      return "added";
    },
    cancel: (sender, matches) => {
      const stopped = watches.filter((watch) => watch.sender === sender && matches(watch));
      for (const watch of stopped) watches.splice(watches.indexOf(watch), 1);
      return { stopped, withdrawn: 0 };
    },
  };
  runtime.taskManager.model = { plan: async ({ text }) => text.includes("别再")
    ? { type: "unwatch", watchTargets: ["project-a"] }
    : { type: "watch", watchTargets: ["project-a", "project-b"] } };
  assert.match(await receive("同时帮我盯住 project-a 和 project-b，结束时通知我"), /thread-a.*thread-b/s);
  assert.match(await receive("正在盯哪些任务"), /thread-a.*thread-b/s);
  assert.match(await receive("别再盯 project-a"), /已停止监听.*thread-a/);
  const remaining = await receive("正在盯哪些任务");
  assert.match(remaining, /thread-b/);
  assert.doesNotMatch(remaining, /thread-a/);
  assert.match(await receive("停止全部监听"), /已停止监听.*thread-b/);
  assert.match(await receive("正在盯哪些任务"), /目前没有/);
  assert.deepEqual(sent, []);
  assert.deepEqual(resumed, []);
});

test("lists multiple allowed projects and filters paths before paginating", async (t) => {
  const { runtime, cwdA, cwdB, sessions, replies, receive } = makeFixture(t);
  sessions.get("thread-b").status = { type: "active", activeFlags: ["waitingOnApproval"] };
  const additionalThreads = Array.from({ length: 11 }, (_, i) => makeThread(`extra-${i}`, cwdA));
  runtime.codex.sendRequest = async (method, params, options) => {
    assert.equal(method, "thread/turns/list");
    assert.equal(params.itemsView, "notLoaded");
    assert.equal(options.observeTimeout, false);
    if (params.threadId === "thread-a") return { result: { data: [{ status: "completed" }] } };
    if (params.threadId === "extra-0") return { result: { data: [{ status: "inProgress" }] } };
    throw new Error("No history available");
  };
  runtime.codex.listThreads = async ({ cursor, sourceKinds, modelProviders, sortKey, sortDirection }) => {
    assert.ok(sourceKinds.includes("appServer"));
    assert.deepEqual(modelProviders, []);
    assert.equal(sortKey, "updated_at");
    assert.equal(sortDirection, "desc");
    return cursor
      ? { result: { data: [sessions.get("thread-b"), ...additionalThreads] } }
      : { result: { data: [sessions.get("thread-outside"), sessions.get("thread-a"), sessions.get("thread-link")], nextCursor: "next" } };
  };

  await receive("你要按照时间顺序列出来最近的 10 个会话");
  assert.match(replies.at(-1), /^1\. thread-a\b/m);
  assert.match(replies.at(-1), /^2\. thread-b\b/m);
  assert.ok(!replies.at(-1).includes(cwdA));
  assert.ok(!replies.at(-1).includes(cwdB));
  assert.match(replies.at(-1), /^1\. thread-a · 上次完成$/m);
  assert.match(replies.at(-1), /^2\. thread-b · 等待审批$/m);
  assert.match(replies.at(-1), /^3\. extra-0 · 上次记录未结束$/m);
  assert.match(replies.at(-1), /历史可查/);
  assert.doesNotMatch(replies.at(-1), /实时状态未知/);
  assert.equal((replies.at(-1).match(/^\d+\. /gm) || []).length, 10);
  assert.doesNotMatch(replies.at(-1), /\/codex/);
  assert.doesNotMatch(replies.at(-1), /thread-outside|thread-link|extra-8|extra-9|extra-10/);
  assert.match(replies.at(-1), /下一页/);

  await receive("下一页");
  assert.match(replies.at(-1), /extra-8/);
  assert.match(replies.at(-1), /extra-10/);
  assert.doesNotMatch(replies.at(-1), /thread-a|thread-b|下一页/);
  assert.match(await receive("下一页"), /没有可翻到的下一页/);
});

test("selects by ID and routes each follow-up to its original thread", async (t) => {
  const { runtime, cwdA, cwdB, replies, resumed, sent, receive, bindingKey } = makeFixture(t);
  assert.match(await receive("/codex use thread-a"), /--confirm-idle/);
  assert.deepEqual(resumed, []);
  assert.equal(runtime.sessionStore.getActiveWorkspaceRoot(bindingKey), "");

  await receive("/codex use thread-a --confirm-idle");
  assert.match(replies.at(-1), /已续接原会话/);
  await receive("Follow-up for A");
  await receive("/codex use thread-b");
  await receive("Follow-up for B");
  assert.deepEqual(resumed, ["thread-a", "thread-b"]);
  assert.deepEqual(sent.map(({ threadId, workspaceRoot, text }) => ({ threadId, workspaceRoot, text })), [
    { threadId: "thread-a", workspaceRoot: cwdA, text: "Follow-up for A" },
    { threadId: "thread-b", workspaceRoot: cwdB, text: "Follow-up for B" },
  ]);

  const loaded = new SessionStore({ filePath: runtime.config.sessionsFile });
  assert.equal(loaded.getActiveWorkspaceRoot(bindingKey), cwdB);
  assert.equal(loaded.getThreadIdForWorkspace(bindingKey, cwdA), "thread-a");
  assert.equal(loaded.getThreadIdForWorkspace(bindingKey, cwdB), "thread-b");
  assert.ok(loaded.isExplicitThreadSelection(bindingKey, cwdA));
  assert.ok(loaded.isExplicitThreadSelection(bindingKey, cwdB));
});

test("refuses busy and unauthorized sessions without changing the selection", async (t) => {
  const { runtime, cwdB, sessions, replies, resumed, sent, receive, bindingKey } = makeFixture(t);
  await receive("/codex use thread-b");
  sessions.get("thread-a").status = { type: "active" };

  assert.match(await receive("/codex use thread-a --confirm-idle"), /正在运行/);
  assert.match(await receive("/codex use thread-outside"), /项目白名单/);
  assert.match(await receive("/codex use thread-link"), /项目白名单/);
  assert.match(await receive("/codex use missing"), /找不到指定/);
  await receive("/codex use thread-a", "other-user");
  assert.match(replies.at(-1), /未允许/);
  assert.equal(runtime.sessionStore.getActiveWorkspaceRoot(bindingKey), cwdB);
  assert.deepEqual(resumed, ["thread-b"]);

  sessions.get("thread-b").status = { type: "active" };
  assert.match(await receive("Do not queue or steer this"), /正在运行/);
  runtime.config.workspaceAllowlist = [sessions.get("thread-a").cwd];
  assert.match(await receive("Do not send after access was revoked"), /项目白名单/);
  assert.deepEqual(sent, []);
});

test("never replaces a lost explicit thread, even if it disappears during submission", async (t) => {
  const { runtime, cwdB, sessions, receive, bindingKey } = makeFixture(t);
  await receive("/codex use thread-b");
  runtime.codex.sendUserMessage = async () => { throw new Error("thread not found"); };
  assert.match(await receive("Still for B"), /已选中的 Codex 会话不可用/);
  sessions.delete("thread-b");
  assert.match(await receive("Still for B"), /找不到指定/);
  assert.equal(runtime.sessionStore.getThreadIdForWorkspace(bindingKey, cwdB), "thread-b");
  assert.ok(runtime.sessionStore.isExplicitThreadSelection(bindingKey, cwdB));
});

test("natural-language selection resolves a numbered candidate and explicitly confirms an idle handoff", async (t) => {
  const { runtime, sessions, sent, resumed, receive } = makeFixture(t);
  sessions.get("thread-a").name = "修复审批回调";
  sessions.get("thread-b").name = "修复审批重试";
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });

  assert.match(await receive("我有哪些 Codex 会话"), /^1\. 修复审批回调/m);
  assert.match(await receive("切到修审批的那条会话"), /找到多条会话/);
  assert.match(await receive("第一条"), /已选中「修复审批回调」/);
  assert.deepEqual(resumed, []);
  assert.match(await receive("继续修，先跑审批测试"), /确认继续/);
  assert.deepEqual(sent, []);

  await receive("确认继续");
  assert.deepEqual(resumed, ["thread-a"]);
  assert.deepEqual(sent.map(({ threadId, text }) => ({ threadId, text })), [
    { threadId: "thread-a", text: "继续修，先跑审批测试" },
  ]);
});

test("a stuck task and a stalled summary leave another session usable", async (t) => {
  const { runtime, sessions, replies, sent, receive } = makeFixture(t);
  sessions.get("thread-a").status.type = "idle";
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  runtime.codex.sendRequest = async (method) => {
    assert.equal(method, "thread/turns/list");
    return { result: { data: [{ items: [{ type: "agentMessage", text: "A 的部分结果" }] }] } };
  };
  let rejectSummary;
  let seenSummary;
  runtime.taskManager.model = {
    enabled: true,
    summarize: (input) => {
      seenSummary = input;
      return new Promise((_, reject) => { rejectSummary = reject; });
    },
  };
  await receive("切到 project-a");
  await receive("跑 A 的测试");
  runtime.activeTurnIdByThreadId.set("thread-a", "stuck-turn");
  sessions.get("thread-a").status.type = "active";
  assert.match(await receive("当前会话还在跑吗"), /运行中/);
  assert.match(await receive("总结一下刚才的结果"), /正在读取/);
  assert.equal(seenSummary.partial, true);
  assert.deepEqual(seenSummary.messages, [{ role: "assistant", text: "A 的部分结果" }]);

  assert.match(await receive("在吗"), /微信桥接在线/);
  await receive("切到 project-b，帮我跑 B 的测试");
  assert.deepEqual(sent.map((entry) => entry.threadId), ["thread-a", "thread-b"]);
  rejectSummary(new Error("summary timed out"));
  for (let attempt = 0; attempt < 10 && !replies.some((text) => text.includes("暂时无法生成总结")); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.match(replies.at(-1), /暂时无法生成总结/);
});

test("an explicit file summarization request goes to the selected project", async (t) => {
  const { sent, receive } = makeFixture(t);
  await receive("/codex use thread-b");
  await receive("总结 README.md 的内容");
  assert.deepEqual(sent.map(({ threadId, text }) => ({ threadId, text })), [
    { threadId: "thread-b", text: "总结 README.md 的内容" },
  ]);
});

test("all-local scope lists and selects visible sessions beyond the configured test roots", async (t) => {
  const { runtime, sessions, sent, receive, bindingKey } = makeFixture(t);
  runtime.config.allLocalSessions = true;
  const visible = sessions.get("thread-outside");
  const archived = makeThread("thread-archived", visible.cwd, "idle");
  sessions.set(archived.id, archived);
  runtime.codex.listThreads = async ({ cwd }) => ({ result: { data: [...sessions.values()]
    .filter((thread) => thread.id !== archived.id && (!cwd || thread.cwd === cwd)) } });

  assert.match(await receive("我有哪些 Codex 会话"), /^\d+\. thread-outside\b/m);
  assert.doesNotMatch(await receive("我有哪些 Codex 会话"), /thread-archived/);
  assert.match(await receive("/codex use thread-archived"), /已归档/);
  assert.match(await receive("/codex use thread-outside", "someone-else"), /未允许/);
  assert.match(await receive("/codex use thread-outside"), /已续接原会话/);
  assert.equal(runtime.sessionStore.getActiveWorkspaceRoot(bindingKey), visible.cwd);
  await receive("Read the current project");
  assert.deepEqual(sent.map(({ threadId }) => threadId), ["thread-outside"]);
});

test("a natural project status report uses the newest matching history instead of the selected session", async (t) => {
  const { runtime, cwdA, cwdB, sessions, replies, resumed, sent, receive, bindingKey } = makeFixture(t);
  await receive("/codex use thread-a --confirm-idle");
  sessions.delete("thread-a");

  const cocos = path.join(cwdB, "cocos-billiards");
  fs.mkdirSync(cocos);
  const latest = sessions.get("thread-b");
  Object.assign(latest, { cwd: cocos, name: "继续开发台球项目 (2)", updatedAt: 1794120000 });
  sessions.set("older-cocos", { ...makeThread("older-cocos", cocos), name: "创建台球项目" });
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  runtime.codex.sendRequest = async (method, params) => {
    assert.equal(method, "thread/items/list");
    assert.equal(params.threadId, latest.id);
    if (!params.cursor) return { result: { data: Array.from({ length: 60 }, () => ({
      turnId: "cocos-current", item: { type: "reasoning" },
    })), nextCursor: "next" } };
    assert.equal(params.cursor, "next");
    return { result: { data: [
      { turnId: "cocos-current", item: { type: "agentMessage", phase: "commentary", text: "已实现中式八球规则，下一步是验证判罚。" } },
      { turnId: "cocos-previous", item: { type: "agentMessage", phase: "commentary", text: "这是上一轮的旧进展。" } },
    ] } };
  };

  await receive("我有一个台球游戏的 Cocos 游戏正在开发过程中，给我汇报一下它现在的状态");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(replies.at(-1), /继续开发台球项目 \(2\)/);
  assert.match(replies.at(-1), /最近更新/);
  assert.match(replies.at(-1), /已实现中式八球规则/);
  assert.doesNotMatch(replies.at(-1), /上一轮的旧进展/);
  assert.equal(runtime.sessionStore.getActiveWorkspaceRoot(bindingKey), cwdA);
  assert.deepEqual(resumed, ["thread-a"]);
  assert.deepEqual(sent, []);
  assert.match(await receive("给我汇报一下不存在的项目现在的状态"), /没找到匹配的会话/);
  assert.deepEqual(sent, []);
});

test("the manager chooses a target for dispatch without switching the selected session", async (t) => {
  const { runtime, cwdA, cwdB, sessions, sent, resumed, receive, bindingKey } = makeFixture(t);
  await receive("/codex use thread-a --confirm-idle");
  runtime.config.agentManager = true;
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  const plans = [];
  runtime.taskManager.model = {
    plan: async (input) => {
      plans.push(input);
      return { type: "dispatch", query: "project-b", contextTarget: "none", reply: "", assignment: {
        objective: "验证现有测试套件", scope: ["运行项目现有测试"], constraints: ["保持源码不变"], deliverables: ["报告测试结果"],
      } };
    },
  };

  const original = "让 project-b 的会话跑一遍测试，先别改代码";
  await receive(original);
  assert.equal(plans[0].context.selected.project, "project-a");
  assert.equal(plans.length, 1);
  assert.deepEqual(resumed, ["thread-a", "thread-b"]);
  assert.deepEqual(sent.map(({ threadId, workspaceRoot }) => ({ threadId, workspaceRoot })), [
    { threadId: "thread-b", workspaceRoot: cwdB },
  ]);
  assert.match(sent[0].text, /任务目标\n验证现有测试套件/);
  assert.match(sent[0].text, /约束\n- 保持源码不变/);
  assert.ok(!sent[0].text.includes(original));
  assert.equal(runtime.sessionStore.getActiveWorkspaceRoot(bindingKey), cwdA);
});

test("a confirmed desktop owner receives the task through the native queue without a resume attempt", async (t) => {
  const { runtime, cwdA, sessions, sent, receive, bindingKey } = makeFixture(t);
  await receive("/codex use thread-a --confirm-idle");
  sessions.get("thread-b").status.type = "notLoaded";
  runtime.config.agentManager = true;
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  runtime.taskManager.model = {
    plan: async () => ({ type: "dispatch", query: "project-b", contextTarget: "none", reply: "", assignment: {
      objective: "验证项目测试", scope: ["运行现有测试"], constraints: ["保持源码不变"], deliverables: ["报告结果"],
    } }),
  };
  runtime.codex.hasDesktopThreadOwner = async (id) => id === "thread-b";
  runtime.codex.resumeThread = async () => assert.fail("desktop-owned thread must not be resumed");
  const queue = [];
  runtime.codex.enqueueExistingThread = async (id, text) => { queue.push({ id, text }); return "receipt"; };

  const reply = await receive("让 project-b 的会话跑一遍测试，先别改代码");
  assert.match(reply, /已排入.*原生队列.*等待原会话接收/);
  assert.doesNotMatch(reply, /确认继续/);
  assert.deepEqual(queue.map(({ id }) => id), ["thread-b"]);
  assert.match(queue[0].text, /约束\n- 保持源码不变/);
  assert.deepEqual(sent, []);
  assert.equal(runtime.sessionStore.getActiveWorkspaceRoot(bindingKey), cwdA);
});

test("an ambiguous planned dispatch keeps the task brief until the user chooses", async (t) => {
  const { runtime, cwdB, sessions, sent, receive } = makeFixture(t);
  sessions.set("thread-b-other", makeThread("thread-b-other", cwdB, "idle"));
  runtime.config.agentManager = true;
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  runtime.taskManager.model = {
    plan: async () => ({ type: "dispatch", query: "project-b", contextTarget: "none", reply: "", assignment: {
      objective: "验证项目测试", scope: ["运行现有测试"], constraints: [], deliverables: ["报告通过和失败情况"],
    } }),
  };

  const original = "让 project-b 的 Codex 跑测试";
  assert.match(await receive(original), /找到多条会话/);
  assert.deepEqual(sent, []);
  await receive("第二条");
  assert.deepEqual(sent.map(({ threadId }) => threadId), ["thread-b-other"]);
  assert.match(sent[0].text, /回报结果\n- 报告通过和失败情况/);
  assert.ok(!sent[0].text.includes(original));
});

test("the manager checks historical verification without sending a project task", async (t) => {
  const { runtime, sessions, sent, resumed, replies, receive } = makeFixture(t);
  runtime.config.agentManager = true;
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  runtime.codex.sendRequest = async (method, params) => {
    assert.equal(method, "thread/items/list");
    assert.equal(params.threadId, "thread-b");
    return { result: { data: [
      { item: { type: "agentMessage", text: "验证结果已记录。" } },
      { item: { type: "commandExecution", command: "npm test", status: "completed", exitCode: 0, aggregatedOutput: "3 tests passed" } },
    ] } };
  };
  let evidence;
  runtime.taskManager.model = {
    enabled: true,
    plan: async () => ({ type: "inspect", query: "project-b", contextTarget: "none", reply: "" }),
    summarize: async (input) => { evidence = input; return "已有记录显示 3 项测试通过。"; },
  };
  await receive("查一下 project-b 上次是不是真的跑过测试");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(evidence.inspect, true);
  assert.ok(evidence.messages.some(({ role, text }) => role === "verification" && text.includes("3 tests passed")));
  assert.match(replies.at(-1), /3 项测试通过/);
  assert.deepEqual(sent, []);
  assert.deepEqual(resumed, []);
});

test("manager failure and an explicit progress question cannot silently submit to the active session", async (t) => {
  const { runtime, sessions, sent, receive } = makeFixture(t);
  await receive("/codex use thread-a --confirm-idle");
  runtime.config.agentManager = true;
  runtime.taskManager.model = { plan: async () => { throw new Error("planner timeout"); } };

  assert.match(await receive("继续修这个问题"), /总管暂时无法判断/);
  assert.deepEqual(sent, []);

  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  runtime.codex.sendRequest = async () => ({ result: { data: [{ item: { type: "agentMessage", text: "B 的进展记录" } }] } });
  runtime.taskManager.model = {
    plan: async () => ({ type: "dispatch", query: "project-a", contextTarget: "none", reply: "" }),
  };
  await receive("给我汇报一下 project-b 现在的状态");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, []);
});

test("a progress follow-up asks for a project when the selected session is archived", async (t) => {
  const { runtime, sessions, sent, receive, bindingKey } = makeFixture(t);
  await receive("/codex use thread-a --confirm-idle");
  runtime.config.allLocalSessions = true;
  runtime.config.agentManager = true;
  runtime.codex.listThreads = async () => ({ result: { data: [sessions.get("thread-b")] } });
  runtime.taskManager.model = {
    plan: async () => ({ type: "status", query: "thread-a", contextTarget: "selected", reply: "" }),
  };

  const reply = await receive("看看进度");
  assert.match(reply, /会话已归档或不可用。你想看哪个项目或会话的进度/);
  assert.doesNotMatch(reply, /处理失败/);
  assert.equal(runtime.sessionStore.getManagerTarget(bindingKey), null);
  assert.deepEqual(sent, []);
});

test("a progress follow-up remembers the last valid report target across restart", async (t) => {
  const { runtime, cwdA, sessions, sent, receive, bindingKey, replies } = makeFixture(t);
  await receive("/codex use thread-a --confirm-idle");
  runtime.config.agentManager = true;
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  runtime.codex.sendRequest = async (method, params) => {
    assert.equal(method, "thread/items/list");
    assert.equal(params.threadId, "thread-b");
    return { result: { data: [{ item: { type: "agentMessage", text: "B 的进展记录" } }] } };
  };
  runtime.taskManager.model = {
    plan: async () => ({ type: "status", query: "project-b", contextTarget: "none", reply: "" }),
  };
  await receive("汇报一下 project-b 的进度");
  await new Promise((resolve) => setImmediate(resolve));
  runtime.sessionStore = new SessionStore({ filePath: runtime.config.sessionsFile });
  assert.equal(runtime.sessionStore.getManagerTarget(bindingKey)?.id, "thread-b");

  runtime.taskManager.model.plan = async () => { throw new Error("model timeout"); };
  await receive("看看进度");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(replies.at(-1), /B 的进展记录/);
  assert.equal(runtime.sessionStore.getActiveWorkspaceRoot(bindingKey), cwdA);
  assert.deepEqual(sent, []);
});

test("viewing the second task remembers that exact list entry for a later progress question", async (t) => {
  const { runtime, cwdA, sessions, replies, sent, receive, bindingKey } = makeFixture(t);
  await receive("/codex use thread-a --confirm-idle");
  runtime.config.agentManager = true;
  runtime.codex.listThreads = async () => ({ result: { data: [sessions.get("thread-a"), sessions.get("thread-b")] } });
  runtime.codex.sendRequest = async (method, params) => {
    assert.equal(method, "thread/items/list");
    assert.equal(params.threadId, "thread-b");
    return { result: { data: [{ item: { type: "agentMessage", text: "第二条的进展" } }] } };
  };
  const model = {
    plan: async ({ text }) => text === "列出会话"
      ? { type: "list", query: "", choiceIndex: 0, contextTarget: "none", reply: "" }
      : { type: "status", query: "thread-a", choiceIndex: 0, contextTarget: "selected", reply: "" },
  };
  runtime.taskManager.model = model;
  assert.match(await receive("列出会话"), /^2\. thread-b/m);
  runtime.sessionStore.state.managerLists[bindingKey].until = Date.now() - 3 * 24 * 60 * 60_000;
  runtime.sessionStore.save();

  runtime.sessionStore = new SessionStore({ filePath: runtime.config.sessionsFile });
  const { TaskManager } = require("../src/app/task-manager");
  runtime.taskManager = new TaskManager(runtime, model);
  runtime.codex.listThreads = async () => ({ result: { data: [sessions.get("thread-b"), sessions.get("thread-a")] } });
  await receive("我想看第二个任务");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(replies.at(-1), /第二条的进展/);
  assert.equal(runtime.sessionStore.getManagerTarget(bindingKey)?.id, "thread-b");
  assert.equal(runtime.sessionStore.getActiveWorkspaceRoot(bindingKey), cwdA);

  await receive("看看进度");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(replies.at(-1), /第二条的进展/);
  assert.deepEqual(sent, []);
});

test("the agent can reference a numbered list item without inventing a session ID", async (t) => {
  const { runtime, sessions, replies, sent, receive } = makeFixture(t);
  runtime.config.agentManager = true;
  runtime.codex.listThreads = async () => ({ result: { data: [sessions.get("thread-a"), sessions.get("thread-b")] } });
  runtime.codex.sendRequest = async (method, params) => {
    assert.equal(method, "thread/items/list");
    assert.equal(params.threadId, "thread-b");
    return { result: { data: [{ item: { type: "agentMessage", text: "编号命中第二条" } }] } };
  };
  runtime.taskManager.model = {
    plan: async ({ context }) => {
      assert.deepEqual(context.choices.map(({ index, title }) => ({ index, title })), [
        { index: 1, title: "thread-a" }, { index: 2, title: "thread-b" },
      ]);
      return { type: "status", query: "", choiceIndex: 2, contextTarget: "none", reply: "" };
    },
  };
  await receive("/codex sessions");
  await receive("我关心刚才排第二位的进展");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(replies.at(-1), /编号命中第二条/);
  assert.deepEqual(sent, []);
});

test("a delayed task resend can still target the prior project rather than an archived selection", async (t) => {
  const { runtime, cwdA, cwdB, sessions, sent, receive, bindingKey } = makeFixture(t);
  await receive("/codex use thread-a --confirm-idle");
  sessions.delete("thread-a");
  runtime.config.agentManager = true;
  runtime.sessionStore.state.managerTargets[bindingKey] = {
    id: "thread-b", cwd: cwdB, title: "台球项目", until: Date.now() - 3 * 24 * 60 * 60_000,
  };
  runtime.sessionStore.save();
  runtime.sessionStore = new SessionStore({ filePath: runtime.config.sessionsFile });
  runtime.taskManager.model = {
    plan: async ({ context }) => {
      assert.equal(context.previous?.title, "台球项目");
      return { type: "dispatch", query: "", choiceIndex: 0, contextTarget: "previous", reply: "", assignment: {
        objective: "改善球杆瞄准", scope: ["支持点击台面调整球杆方向"], constraints: [], deliverables: ["回报验证结果"],
      } };
    },
  };

  await receive("增加点击台面调整球杆方向的功能");
  assert.deepEqual(sent.map(({ threadId }) => threadId), ["thread-b"]);
  assert.equal(runtime.sessionStore.getActiveWorkspaceRoot(bindingKey), cwdA);
  assert.equal(runtime.sessionStore.getManagerTarget(bindingKey)?.task, "改善球杆瞄准");
});

test("legacy manager context remains available regardless of its old expiry timestamp", (t) => {
  const { runtime, cwdB, bindingKey } = makeFixture(t);
  runtime.sessionStore.state.managerTargets[bindingKey] = {
    id: "thread-b", cwd: cwdB, title: "台球项目", until: Date.now() - 2 * 60 * 60_000,
  };
  assert.equal(runtime.sessionStore.getManagerTarget(bindingKey)?.id, "thread-b");
});

test("cancelling a pending assignment keeps the list but a later number does not send the cancelled task", async (t) => {
  const { runtime, cwdB, sessions, sent, receive, bindingKey } = makeFixture(t);
  sessions.set("thread-b-other", makeThread("thread-b-other", cwdB, "idle"));
  runtime.config.agentManager = true;
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  runtime.taskManager.model = {
    plan: async () => ({ type: "dispatch", query: "project-b", contextTarget: "none", reply: "", assignment: {
      objective: "验证项目测试", scope: ["运行现有测试"], constraints: [], deliverables: ["报告通过和失败情况"],
    } }),
  };

  assert.match(await receive("让 project-b 跑测试"), /找到多条会话/);
  assert.match(await receive("算了"), /已取消/);
  assert.match(await receive("第二条"), /已选中/);
  assert.equal(runtime.sessionStore.getThreadIdForWorkspace(bindingKey, cwdB), "thread-b-other");
  assert.deepEqual(sent, []);
});

test("a project reply resumes the manager conversation and delegates the original read-only investigation", async (t) => {
  const { runtime, cwdB, sessions, sent, receive, bindingKey } = makeFixture(t);
  runtime.config.agentManager = true;
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  let previous;
  const model = {
    plan: async ({ text, conversation }) => {
      if (!conversation.threadId) {
        previous = text;
        conversation.saveThreadId("manager-thread");
        return { type: "clarify", reply: "Cocos 还是 BilliardGL？" };
      }
      assert.equal(conversation.threadId, "manager-thread");
      assert.match(previous, /为什么袋口/);
      assert.equal(text, "cocos");
      return { type: "investigate", query: "project-b", contextTarget: "none", assignment: {
        objective: "定位袋口切口为何与设计稿不一致", scope: ["核对当前实现"], constraints: [], deliverables: ["报告依据"],
      } };
    },
  };
  runtime.taskManager.model = model;
  assert.match(await receive("为什么袋口是直的？"), /Cocos 还是 BilliardGL/);

  runtime.sessionStore = new SessionStore({ filePath: runtime.config.sessionsFile });
  const { TaskManager } = require("../src/app/task-manager");
  runtime.taskManager = new TaskManager(runtime, model);
  await receive("cocos");
  assert.equal(runtime.sessionStore.getManagerThread(bindingKey), "manager-thread");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, "thread-b");
  assert.equal(sent[0].workspaceRoot, cwdB);
  assert.equal(sent[0].accessMode, "read-only");
  assert.match(sent[0].text, /定位袋口切口为何与设计稿不一致/);
  assert.match(sent[0].text, /不修改文件/);
});

test("a bare project answer queues the pending investigation with a read-only task brief", async (t) => {
  const { runtime, sessions, sent, receive, bindingKey } = makeFixture(t);
  sessions.get("thread-b").status.type = "notLoaded";
  runtime.config.agentManager = true;
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  runtime.codex.hasDesktopThreadOwner = async (id) => id === "thread-b";
  runtime.codex.resumeThread = async () => assert.fail("desktop-owned thread must not be resumed");
  const queued = [];
  runtime.codex.enqueueExistingThread = async (id, text) => { queued.push({ id, text }); return "receipt"; };
  const assignment = { objective: "查袋口切口", scope: ["读取渲染源码"], constraints: [], deliverables: ["报告证据"] };
  runtime.taskManager.model = {
    plan: async ({ text, context }) => {
      if (text === "接着查袋口问题") return { type: "clarify", reply: "Cocos 还是 BilliardGL？",
        pendingInvestigation: true, assignment };
      assert.equal(context.pendingInvestigation.assignment.objective, assignment.objective);
      return { type: "dispatch", query: "project-b", contextTarget: "none", assignment };
    },
  };
  assert.match(await receive("接着查袋口问题"), /Cocos 还是 BilliardGL/);
  runtime.sessionStore = new SessionStore({ filePath: runtime.config.sessionsFile });
  assert.match(await receive("cocos"), /已排入.*原生队列/);
  assert.equal(runtime.sessionStore.getPendingInvestigation(bindingKey), null);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].id, "thread-b");
  assert.match(queued[0].text, /查袋口切口/);
  assert.match(queued[0].text, /只读排查，不修改文件/);
  assert.deepEqual(sent, []);
});

test("an unowned historical session is only resumed after an explicit transfer", async (t) => {
  const { runtime, sessions, sent, resumed, receive } = makeFixture(t);
  runtime.config.agentManager = true;
  sessions.get("thread-b").status.type = "notLoaded";
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  runtime.codex.hasDesktopThreadOwner = async () => false;
  runtime.codex.enqueueExistingThread = async () => assert.fail("unknown owner must not receive a queue item");
  runtime.taskManager.model = { plan: async () => ({
    type: "dispatch", query: "project-b", contextTarget: "none", assignment: {
      objective: "验证测试", scope: ["运行项目测试"], constraints: [], deliverables: ["报告结果"],
    },
  }) };

  assert.match(await receive("让 project-b 跑测试"), /无法确认.*确认移交/);
  assert.deepEqual(resumed, []);
  assert.deepEqual(sent, []);
  await receive("确认移交");
  assert.deepEqual(resumed, ["thread-b"]);
  assert.deepEqual(sent.map(({ threadId }) => threadId), ["thread-b"]);
});

test("new-session planning reuses a matching thread, and never creates a fallback when it is busy", async (t) => {
  const { runtime, sessions, sent, receive } = makeFixture(t);
  runtime.config.agentManager = true;
  sessions.get("thread-b").name = "导出测试";
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  runtime.taskManager.model = { plan: async () => ({
    type: "dispatch", project: "project-b", query: "导出测试", newSession: "if_missing", contextTarget: "none",
    assignment: { objective: "验证导出", scope: ["执行导出测试"], constraints: [], deliverables: ["汇报结果"] },
  }) };
  await receive("检查 project-b 导出流程");
  assert.deepEqual(sent.map(({ threadId }) => threadId), ["thread-b"]);
  sessions.get("thread-b").status.type = "active";
  assert.match(await receive("再检查 project-b 导出流程"), /会话正在运行/);
  assert.equal(sent.length, 1);
});

test("a distinct task creates a named project thread and sends only the structured brief", async (t) => {
  const { runtime, cwdB, sessions, sent, receive, bindingKey } = makeFixture(t);
  runtime.config.agentManager = true;
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  const cwd = fs.realpathSync(cwdB);
  runtime.codex.startThread = async (params) => {
    assert.deepEqual(params, { cwd });
    return { result: { thread: makeThread("new-thread", cwd, "idle") } };
  };
  runtime.codex.sendRequest = async (method, params) => {
    assert.equal(method, "thread/name/set");
    assert.deepEqual(params, { threadId: "new-thread", name: "检查导出兼容性" });
  };
  runtime.taskManager.model = { plan: async () => ({
    type: "investigate", project: "project-b", query: "导出兼容性", newSession: "if_missing", contextTarget: "none",
    assignment: { objective: "检查导出兼容性", scope: ["检查导出模块"], constraints: [], deliverables: ["汇报证据"] },
  }), chooseSession: async ({ candidates }) => {
    assert.deepEqual(candidates, ["thread-b"]);
    return { decision: "create" };
  } };
  await receive("project-b 的导出兼容性为什么有问题？");
  assert.equal(runtime.sessionStore.getManagerTarget(bindingKey).id, "new-thread");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, "new-thread");
  assert.equal(sent[0].accessMode, "read-only");
  assert.match(sent[0].text, /检查导出模块/);
});

test("an uncertain creation waits across restart and uses the original task on confirmation", async (t) => {
  const { runtime, cwdB, sessions, sent, receive, bindingKey } = makeFixture(t);
  runtime.config.agentManager = true;
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  runtime.taskManager.model = { plan: async ({ text, context }) => {
    if (text === "那就单独开一条来做吧") {
      assert.equal(context.pendingCreation.objective, "检查导出");
      return { type: "confirm_create" };
    }
    return { type: "dispatch", project: "project-b", query: "导出检查", newSession: "ask", contextTarget: "none",
      assignment: { objective: "检查导出", scope: ["检查导出模块"], constraints: [], deliverables: ["汇报结果"] } };
  } };
  assert.match(await receive("检查 project-b 导出"), /回复编号.*新建会话/s);
  assert.equal(sent.length, 0);
  runtime.sessionStore = new SessionStore({ filePath: runtime.config.sessionsFile });
  assert.equal(runtime.sessionStore.getPendingSessionCreation(bindingKey).intent.assignment.objective, "检查导出");
  runtime.codex.startThread = async ({ cwd }) => {
    assert.equal(cwd, fs.realpathSync(cwdB));
    return { result: { thread: makeThread("new-thread", cwd, "idle") } };
  };
  runtime.codex.sendRequest = async () => {};
  await receive("那就单独开一条来做吧");
  assert.equal(runtime.sessionStore.getPendingSessionCreation(bindingKey), null);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /检查导出模块/);
  assert.doesNotMatch(sent[0].text, /单独开一条/);
});

test("the manager can reuse a related project thread whose title lacks the search keywords", async (t) => {
  const { runtime, sessions, sent, receive } = makeFixture(t);
  runtime.config.agentManager = true;
  sessions.get("thread-b").name = "下载流程";
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  runtime.taskManager.model = { plan: async () => ({
    type: "dispatch", project: "project-b", query: "导出", newSession: "if_missing", contextTarget: "none",
    assignment: { objective: "修改导出流程", scope: ["修改文件下载"], constraints: [], deliverables: ["汇报验证结果"] },
  }), chooseSession: async ({ candidates }) => {
    assert.deepEqual(candidates, ["下载流程"]);
    return { decision: "reuse", index: 1 };
  } };
  await receive("让 project-b 修一下导出");
  assert.deepEqual(sent.map(({ threadId }) => threadId), ["thread-b"]);
});

test("an explicit empty session can ask for the project before initializing it read-only", async (t) => {
  const { runtime, cwdB, sessions, sent, receive, bindingKey } = makeFixture(t);
  runtime.config.agentManager = true;
  runtime.codex.listThreads = async () => ({ result: { data: [...sessions.values()] } });
  runtime.taskManager.model = { plan: async ({ text, context }) => {
    if (text === "project-b") {
      assert.equal(context.pendingCreation.needProject, true);
      return { type: "creation_project", project: text };
    }
    return { type: "create", query: "", project: "", title: "回归验证", newSession: "explicit", contextTarget: "none" };
  } };
  assert.match(await receive("帮我建一条叫回归验证的会话"), /告诉我项目名/);
  assert.equal(sent.length, 0);
  runtime.codex.startThread = async ({ cwd }) => {
    assert.equal(cwd, fs.realpathSync(cwdB));
    return { result: { thread: makeThread("empty-new", cwd, "idle") } };
  };
  runtime.codex.sendRequest = async (method, params) => {
    assert.equal(method, "thread/name/set");
    assert.equal(params.name, "回归验证");
  };
  await receive("project-b");
  assert.equal(runtime.sessionStore.getPendingSessionCreation(bindingKey), null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, "empty-new");
  assert.equal(sent[0].accessMode, "read-only");
  assert.match(sent[0].text, /无需执行其他操作/);
});
