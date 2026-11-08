const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { TaskWatches } = require("../src/app/task-watches");
const { MessageStore } = require("../src/infra/storage/message-store");

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
    const job = { id: "watch", sender: "owner", thread: "thread", turn: "turn" };
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
