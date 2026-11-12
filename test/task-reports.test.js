const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { MessageStore } = require("../src/infra/storage/message-store");
const { TaskReports } = require("../src/app/task-reports");
const { mapCodexMessageToImEvent } = require("../src/infra/codex/message-utils");

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wechat-reports-"));
  const file = path.join(directory, "delivery.sqlite");
  const message = { inboxId: "task-1", senderId: "owner", contextToken: "test-context", taskLabel: "验证球杆瞄准", text: "任务单" };
  let store = new MessageStore(file, "account");
  const makeReports = (codex, model) => new TaskReports({
    store, codex, getModel: () => model || { enabled: false },
    buildReply: (user, text) => [{ client_id: "reply-for-task-1", user, text }],
    reportError: () => {},
  });
  const reload = () => {
    store.close();
    store = new MessageStore(file, "account");
    return store;
  };
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { message, store, reload, makeReports };
}

test("a queued assignment is matched to its exact turn and reported once after restart", async (t) => {
  const { message, store, reload, makeReports } = createFixture(t);
  let turns = [];
  const codex = {
    isReady: true,
    sendRequest: async (method, params) => {
      assert.equal(method, "thread/turns/list");
      assert.equal(params.itemsView, "summary");
      return { result: { data: turns } };
    },
  };
  const reporter = makeReports(codex);
  const { id, text } = reporter.register(message, "thread-a", "台球项目");
  const newerUnrelated = { id: "wrong", status: "completed",
    items: [{ type: "agentMessage", text: "无关结果" }] };
  const matched = { id: "right", status: "inProgress",
    items: [{ type: "userMessage", content: [{ type: "text", text }] }] };
  turns = [newerUnrelated, matched];

  await reporter.process(store.nextTaskReports([], 1, Infinity)[0]);
  assert.equal(store.nextReply(), undefined);
  assert.equal(store.nextTaskReports([], 1, Infinity)[0].turn, "right");

  const restarted = reload();
  const restartedReporter = makeReports(codex);
  matched.status = "completed";
  matched.items.push({ type: "agentMessage", text: "修复瞄准并通过测试。" });
  await restartedReporter.process(restarted.nextTaskReports([], 1, Infinity)[0]);
  const ready = restarted.nextTaskReports([], 1)[0];
  await restartedReporter.process(ready);
  await restartedReporter.process(ready);

  const reply = JSON.parse(restarted.nextReply().payload);
  assert.match(reply.text, /「台球项目」已完成/);
  assert.match(reply.text, /修复瞄准并通过测试/);
  assert.doesNotMatch(reply.text, /无关结果/);
  assert.equal(reply.user, "owner");
  restarted.acknowledgeReply(reply.client_id);
  assert.equal(restarted.nextReply(), undefined);
  assert.equal(restarted.nextTaskReports([], 1, Infinity).length, 0);
  assert.equal(id, message.inboxId);
});

test("the reporter summarizes only the recorded result and preserves it if the model fails", async (t) => {
  const { message, store, makeReports } = createFixture(t);
  const detail = "记录中的回归测试结果。".repeat(20);
  const model = { enabled: true, summarize: async ({ messages }) => {
    assert.deepEqual(messages, [{ role: "assistant", text: detail }]);
    throw new Error("model timed out");
  } };
  const reporter = makeReports({ isReady: false }, model);
  const { id } = reporter.register(message, "thread-a", "台球项目");
  store.setReportOutcome(id, "turn-a", { status: "failed", result: detail });
  await reporter.process(store.nextTaskReports([], 1)[0]);
  const reply = JSON.parse(store.nextReply().payload);
  assert.match(reply.text, /执行失败/);
  assert.ok(reply.text.includes(detail));
});

test("an interrupted turn remains interrupted in a result report", () => {
  const event = mapCodexMessageToImEvent({ method: "turn/completed",
    params: { threadId: "thread-a", turn: { id: "turn-a", status: "interrupted" } } });
  assert.equal(event.payload.state, "interrupted");
});

test("an apparent interruption without a recorded end stays pending until the owner finishes", async (t) => {
  const { message, store, makeReports } = createFixture(t);
  let turns;
  const reporter = makeReports({ isReady: true, sendRequest: async () => ({ result: { data: turns } }) });
  const { text } = reporter.register(message, "thread-a", "台球项目");
  const turn = { id: "turn-a", status: "interrupted", completedAt: null,
    items: [{ type: "userMessage", content: [{ type: "text", text }] }] };
  turns = [turn];
  await reporter.process(store.nextTaskReports([], 1, Infinity)[0]);
  const pending = store.nextTaskReports([], 1, Infinity)[0];
  assert.equal(pending.turn, "turn-a");
  assert.equal(pending.outcome, null);
  assert.equal(store.nextReply(), undefined);

  turn.status = "completed";
  turn.completedAt = Date.now() / 1000;
  turn.items.push({ type: "agentMessage", text: "已验证手机访问链接。" });
  await reporter.process(pending);
  await reporter.process(store.nextTaskReports([], 1)[0]);
  assert.match(JSON.parse(store.nextReply().payload).text, /已完成/);
});

test("a historical interruption with a recorded end is reported as interrupted", async (t) => {
  const { message, store, makeReports } = createFixture(t);
  const reporter = makeReports({ isReady: true, sendRequest: async () => ({ result: { data: [turn] } }) });
  const { text } = reporter.register(message, "thread-a", "台球项目");
  const turn = { id: "turn-a", status: "interrupted", completedAt: Date.now() / 1000,
    items: [{ type: "userMessage", content: [{ type: "text", text }] }] };
  await reporter.process(store.nextTaskReports([], 1, Infinity)[0]);
  await reporter.process(store.nextTaskReports([], 1)[0]);
  assert.match(JSON.parse(store.nextReply().payload).text, /已中断/);
});
