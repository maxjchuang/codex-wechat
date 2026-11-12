const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { TaskWatches } = require("../src/app/task-watches");
const { MessageStore } = require("../src/infra/storage/message-store");
const { MessageDelivery } = require("../src/app/message-delivery");

test("watching is read-only, follows exact turns across restart, and deduplicates milestone and terminal delivery", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wechat-watches-"));
  const filename = path.join(directory, "deliveries.sqlite");
  let store = new MessageStore(filename, "account");
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const threadA = { id: "a", cwd: "/project-a" };
  const threadB = { id: "b", cwd: "/project-b" };
  const turnA = { id: "a1", status: "interrupted", completedAt: null };
  const turnB = { id: "b1", status: "inProgress" };
  const turns = { a: [turnA], b: [turnB] };
  const items = { a: [{ type: "agentMessage", phase: "commentary", id: "old", text: "已复现问题" }], b: [] };
  const codex = {
    isReady: true,
    hasLocalThreadWriter: async (id) => id === "a",
    async sendRequest(method, params) {
      if (method === "thread/turns/list") return { result: { data: turns[params.threadId] } };
      if (method === "thread/items/list") {
        assert.ok(["a1", "b1"].includes(params.turnId));
        if (params.threadId === "a" && !params.cursor) return { result: {
          data: [{ item: { type: "reasoning", id: `tool-noise-${items.a[0].id}` } }], nextCursor: "next",
        } };
        return { result: { data: items[params.threadId].map((item) => ({ item })) } };
      }
      assert.equal(method, "thread/read");
      return { result: { thread: { status: { type: "active" } } } };
    },
  };
  const makeWatcher = () => new TaskWatches({
    store, codex, canWatch: async () => true, reportError: (error) => { throw error; },
    buildReply: (_sender, text) => [{ client_id: randomUUID(), text }],
  });
  let watcher = makeWatcher();
  const message = { senderId: "owner", contextToken: "token" };
  assert.equal(await watcher.inspect(threadA), turnA);
  assert.equal(await watcher.inspect(threadB), turnB);
  assert.equal(await watcher.register(message, threadA, "台球", turnA), "added");
  assert.equal(await watcher.register(message, threadA, "台球", turnA), "existing");
  await watcher.register(message, threadB, "导出", turnB);
  const processAll = () => Promise.all(store.nextTaskWatches([], 10, Number.MAX_SAFE_INTEGER).map((job) => watcher.process(job)));
  await processAll();
  assert.equal(store.nextReply(), undefined);
  assert.equal(watcher.list("owner").length, 2);

  items.a.unshift({ type: "agentMessage", phase: "commentary", id: "new", text: "已定位根因，正在验证修复" });
  await processAll();
  assert.match(JSON.parse(store.nextReply().payload).text, /台球.*有新进展.*已定位根因/s);
  store.acknowledgeReply(store.nextReply().id);
  store.close();
  store = new MessageStore(filename, "account");
  watcher = makeWatcher();
  await processAll();
  assert.equal(store.nextReply(), undefined);

  turns.a.unshift({ id: "a2", status: "completed", completedAt: 13 });
  turnA.completedAt = 12;
  turnB.status = "failed";
  turnB.error = { message: "构建超时" };
  await processAll();
  assert.equal(watcher.list("owner").length, 0);
  const delivered = [];
  while (store.nextReply()) {
    delivered.push(JSON.parse(store.nextReply().payload).text);
    store.acknowledgeReply(store.nextReply().id);
  }
  assert.equal(delivered.length, 2);
  assert.ok(delivered.some((text) => /台球.*已中断/.test(text)));
  assert.ok(delivered.some((text) => /关键过程.*已复现问题.*已定位根因/s.test(text)));
  assert.ok(delivered.some((text) => /导出.*执行失败.*构建超时/s.test(text)));
});

test("the automatic assignment report owns the terminal notice when the same turn is watched", async () => {
  const store = new MessageStore(":memory:", "account");
  try {
    const job = { id: "watch", sender: "owner", thread: "thread", turn: "turn", payload: "{}" };
    store.addTaskWatch({ ...job, payload: {}, progress: null, retryAt: 0 });
    store.addTaskReport("report", job.thread, { senderId: job.sender }, 0);
    store.setReportTurn("report", job.turn);
    store.finishTaskWatch(job, [{ client_id: "watch-notice" }]);
    assert.equal(store.nextReply(), undefined);
    store.finishTaskReport("report", [{ client_id: "report-notice" }], job.sender);
    assert.equal(store.nextReply().id, "report-notice");
    store.acknowledgeReply("report-notice");
    store.addTaskWatch({ ...job, payload: {}, progress: null, retryAt: 0 });
    store.finishTaskWatch(job, [{ client_id: "duplicate-notice" }]);
    assert.equal(store.nextReply(), undefined);
  } finally {
    store.close();
  }
});

test("cancellation withdraws failed and finished watch notices across restart without touching other replies", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wechat-cancel-"));
  const filename = path.join(directory, "deliveries.sqlite");
  let store = new MessageStore(filename, "account");
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const watch = (id, cwd, sender = "owner") => {
    store.addTaskWatch({ id, sender, thread: id, turn: id, payload: { title: id, cwd }, progress: null, retryAt: 0 });
    return store.nextTaskWatches([], 10).find((row) => row.id === id);
  };
  const running = watch("running", "/atoms-demo");
  const finished = watch("finished", "/atoms-demo");
  const other = watch("other", "/other");
  const otherSender = watch("other-sender", "/atoms-demo", "another");
  store.advanceTaskWatch(running, 0, { messages: [{ client_id: "retry" }] });
  const attempted = [];
  const failingDelivery = new MessageDelivery({
    store, send: async (message) => { attempted.push(message.client_id); throw new Error("retry"); },
    reportError: () => {},
  });
  await failingDelivery.flushReplies();
  assert.deepEqual(attempted, ["retry"]);
  store.finishTaskWatch(finished, [{ client_id: "terminal-first" }, { client_id: "terminal-second" }]);
  store.advanceTaskWatch(other, 0, { messages: [{ client_id: "other-project" }] });
  store.advanceTaskWatch(otherSender, 0, { messages: [{ client_id: "different-owner" }] });
  const legacy = (id, text) => ({
    client_id: id, to_user_id: "owner", item_list: [{ text_item: { text } }],
  });
  store.enqueueReplies([
    legacy("legacy-progress", "「调研」有新进展\n项目：atoms-demo\n\n已有进展"),
    legacy("automatic-report", "「调研 atoms-demo」已完成\n任务：验收\n\n结果"),
    legacy("ordinary", "「atoms-demo」\n空闲。"),
  ]);
  const matches = ({ cwd }) => cwd === "/atoms-demo" || cwd === "atoms-demo";
  const cancellation = store.cancelTaskWatches("owner", matches);
  assert.deepEqual(cancellation.stopped.map(({ id }) => id), ["running"]);
  assert.equal(cancellation.withdrawn, 4);
  store.advanceTaskWatch(running, 0, { messages: [{ client_id: "late" }] });
  store.close();
  store = new MessageStore(filename, "account");
  const delivered = [];
  await new MessageDelivery({
    store, send: async (message) => delivered.push(message.client_id), reportError: (error) => { throw error; },
  }).flushReplies();
  assert.deepEqual(delivered, ["other-project", "different-owner", "automatic-report", "ordinary"]);
});

test("an ended watch can withdraw queued notices without an active subscription", () => {
  const store = new MessageStore(":memory:", "account");
  try {
    const job = { id: "watch", sender: "owner", thread: "thread", turn: "turn" };
    store.addTaskWatch({ ...job, payload: { title: "atoms-demo" }, progress: null, retryAt: 0 });
    store.finishTaskWatch(store.nextTaskWatches([], 1)[0], [{ client_id: "terminal" }]);
    assert.deepEqual(store.cancelTaskWatches("owner", ({ thread }) => thread === job.thread), { stopped: [], withdrawn: 1 });
    assert.equal(store.nextReply(), undefined);
  } finally {
    store.close();
  }
});
