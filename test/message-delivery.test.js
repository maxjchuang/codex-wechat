const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: wait } = require("node:timers/promises");

const { MessageDelivery } = require("../src/app/message-delivery");
const { MessageStore } = require("../src/infra/storage/message-store");
const { CodexRpcClient } = require("../src/infra/codex/rpc-client");

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wechat-delivery-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return path.join(folder, "deliveries.sqlite");
}

function inbound(id, text, sender = "owner") {
  return { from_user_id: sender, message_id: id, text };
}

async function until(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await wait(10);
  }
  assert.fail("Timed out waiting for delivery");
}

test("persists the cursor and an entire batch together, deduplicates replay, and recovers after restart", (t) => {
  const file = fixture(t);
  let store = new MessageStore(file, "account");
  store.acceptBatch("first", [inbound(1, "send once"), inbound(2, "still pending")], () => false);

  assert.throws(() => store.acceptBatch("rolled-back", [inbound(3, "never persisted"), inbound(4, "bad")], (message) => {
    if (message.message_id === 4) throw new Error("failure during batch");
    return false;
  }));
  assert.equal(store.getCursor(), "first");
  assert.ok(store.claim("1"));
  store.waitForResult("1", "thread-a", "turn-a");
  store.enqueueReplies([{ client_id: "already-generated", text: "queued reply" }]);
  store.close();

  store = new MessageStore(file, "account");
  t.after(() => store.close());
  store.recoverInterrupted((message, job) => [{ client_id: "recovery-" + job.id, text: message.text }]);
  assert.equal(store.getCursor(), "first");
  store.acceptBatch("new", [inbound(1, "send once"), inbound(2, "still pending")], () => false);
  assert.deepEqual(store.nextInbox(false, [], 10).map((job) => job.id), ["2"]);
  assert.equal(store.claim("1"), false);
  assert.equal(store.nextReply().id, "already-generated");
  store.acknowledgeReply("already-generated");
  assert.equal(store.nextReply().id, "recovery-1");
});

test("keeps local status and other senders responsive when an inbox handler waits", async (t) => {
  const store = new MessageStore(fixture(t), "account");
  const received = [];
  const errors = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const delivery = new MessageDelivery({
    store,
    receive: async (message) => {
      received.push(message.text);
      if (message.text === "A RPC stuck") await blocked;
    },
    send: async () => {},
    reportError: (error) => errors.push(error),
  });
  t.after(() => { delivery.stop(); store.close(); });
  store.acceptBatch("batch", [inbound(1, "A RPC stuck"), inbound(2, "status"), inbound(3, "other sender", "other")],
    (message) => message.text === "status");
  delivery.start();
  await until(() => received.length === 3);
  assert.deepEqual(new Set(received), new Set(["A RPC stuck", "status", "other sender"]));
  release();
  await until(() => delivery.normalSenders.size === 0 && delivery.fastSenders.size === 0);
  assert.deepEqual(errors, []);
});

test("retries a queued reply after restart with the original client ID", async (t) => {
  const file = fixture(t);
  let store = new MessageStore(file, "account");
  const sent = [];
  const makeDelivery = (send) => new MessageDelivery({ store, send, receive: async () => {}, reportError() {} });
  store.enqueueReplies([{ client_id: "stable", text: "reply" }]);
  await makeDelivery(async (message) => {
    sent.push(message);
    throw new Error("transient failure");
  }).flushReplies();
  assert.equal(store.nextReply(), undefined);
  store.close();

  store = new MessageStore(file, "account");
  t.after(() => store.close());
  store.delayReply("stable", 0);
  await makeDelivery(async (message) => sent.push(message)).flushReplies();
  assert.deepEqual(sent.map((message) => message.client_id), ["stable", "stable"]);
  assert.equal(store.nextReply(), undefined);
});

test("an unanswered RPC times out without blocking independent RPCs", async () => {
  const client = new CodexRpcClient({ timeoutMs: 20 });
  client.sendRaw = (payload) => {
    const request = JSON.parse(payload);
    if (request.method === "thread/read") {
      queueMicrotask(() => client.handleIncoming(JSON.stringify({ id: request.id, result: { thread: { id: "B" } } })));
    }
  };
  const blocked = client.sendRequest("turn/start", { threadId: "A" });
  assert.equal((await client.readThread("B")).result.thread.id, "B");
  await assert.rejects(blocked, { code: "CODEX_RPC_TIMEOUT", rpcMethod: "turn/start" });
  assert.equal(client.pending.size, 0);
});

test("disconnect rejects outstanding requests instead of leaving promises hanging", async () => {
  const client = new CodexRpcClient({});
  client.sendRaw = () => {};
  const pending = client.sendRequest("turn/start", {});
  client.handleDisconnect();
  await assert.rejects(pending, { code: "CODEX_DISCONNECTED", rpcMethod: "turn/start" });
  assert.equal(client.pending.size, 0);
});

test("an optional history lookup timeout does not mark the Codex connection unhealthy", async () => {
  const client = new CodexRpcClient({ timeoutMs: 10_000 });
  client.sendRaw = () => {};
  await assert.rejects(client.sendRequest("thread/turns/list", {}, { timeoutMs: 10, observeTimeout: false }),
    { code: "CODEX_RPC_TIMEOUT" });
  assert.equal(client.lastRpcTimeoutAt, 0);
  assert.equal(client.pending.size, 0);
});

test("polling and local status work while the Codex connection is down", async (t) => {
  const file = fixture(t);
  const { WechatRuntime } = require("../src/app/wechat-runtime");
  const { saveWeixinAccount } = require("../src/infra/weixin/account-store");
  const folder = path.dirname(file);
  const config = {
    accountId: "account", accountsDir: path.join(folder, "accounts"),
    sessionsFile: path.join(folder, "sessions.json"), deliveriesFile: file,
    syncBufferDir: path.join(folder, "sync"), allowedUserIds: ["owner"],
    defaultWorkspaceId: "default", baseUrl: "https://example.test",
  };
  saveWeixinAccount(config, "account", { token: "test-token", baseUrl: config.baseUrl, userId: "owner" });
  const runtime = new WechatRuntime(config);
  runtime.codex.connect = async () => { throw new Error("test disconnect"); };
  const outgoing = [];
  const cursors = [];
  let acknowledge;
  const replyStarted = new Promise((resolve) => { acknowledge = resolve; });
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("/getupdates")) {
      cursors.push(body.get_updates_buf);
      if (cursors.length === 1) return Response.json({
        ret: 0, get_updates_buf: "next-cursor",
        msgs: [{ from_user_id: "owner", message_id: 1, context_token: "test-context",
          item_list: [{ type: 1, text_item: { text: "在吗" } }] }],
      });
      await replyStarted;
      return Response.json({ ret: -14 });
    }
    assert.ok(url.endsWith("/sendmessage"));
    outgoing.push(body.msg.item_list[0].text_item.text);
    acknowledge();
    return Response.json({ ret: 0 });
  };
  try {
    await assert.rejects(runtime.start(), /重新执行/);
    await until(() => !runtime.delivery.sending && !runtime.delivery.fastSenders.size);
    assert.deepEqual(cursors, ["", "next-cursor"]);
    assert.match(outgoing[0], /微信桥接在线。Codex 暂不可用/);
    assert.equal(runtime.messageStore.getCursor(), "next-cursor");
    assert.equal(runtime.messageStore.nextReply(), undefined);
  } finally {
    global.fetch = originalFetch;
    runtime.messageStore?.close();
  }
});
