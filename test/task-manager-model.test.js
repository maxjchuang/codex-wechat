const assert = require("node:assert/strict");
const test = require("node:test");

const { TaskManagerModel } = require("../src/infra/model/task-manager-model");

function completed(text) {
  return { ok: true, json: async () => ({
    status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }],
  }) };
}

test("classifier sends a tool-free structured request and validates the response", async () => {
  const model = new TaskManagerModel({
    apiKey: "test-key", model: "test-model",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      const body = JSON.parse(options.body);
      assert.deepEqual(body.tools, []);
      assert.equal(body.store, false);
      assert.equal(body.text.format.type, "json_schema");
      assert.ok(options.signal instanceof AbortSignal);
      return completed('{"type":"select","query":"project-a"}');
    },
  });
  assert.deepEqual(await model.classify("能不能回到之前那个 project-a？"), { type: "select", query: "project-a" });
  model.fetch = async () => completed('{"type":"confirm","query":"thread-a"}');
  assert.deepEqual(await model.classify("试图确认"), { type: "clarify" });
});

test("summary model only receives the requested focus and bounded conversation text", async () => {
  const model = new TaskManagerModel({
    apiKey: "test-key", model: "test-model",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.tools, []);
      assert.equal(body.store, false);
      const snapshot = JSON.parse(body.input);
      assert.equal(snapshot.focus, "列出待办");
      assert.equal(snapshot.partial, true);
      assert.deepEqual(snapshot.messages, [{ role: "assistant", text: "a".repeat(3000) }]);
      return completed("待办尚未确认。");
    },
  });
  assert.equal(await model.summarize({
    focus: "列出待办", partial: true, messages: [{ role: "assistant", text: "a".repeat(4000), hidden: "omitted" }],
  }), "待办尚未确认。");
});

test("manager validates a structured assignment and rejects copied or incomplete briefs", async () => {
  const original = "帮我给 project-b 派活，让它跑测试，保持源码不变并汇报结果";
  const assignment = { objective: "验证项目测试", scope: ["运行现有测试"], constraints: ["保持源码不变"], deliverables: ["汇报结果"] };
  const payload = { type: "dispatch", query: "project-b", contextTarget: "none", choiceIndex: 0, assignment, reply: "" };
  const model = new TaskManagerModel({
    runLocal: async ({ format }) => {
      assert.equal(format.name, "codex_wechat_plan");
      assert.ok(format.schema.required.includes("assignment"));
      return JSON.stringify(payload);
    },
  });
  assert.equal(model.enabled, true);
  const input = { text: original, context: {}, attachments: [] };
  const plan = await model.plan(input);
  assert.equal(plan.type, "dispatch");
  assert.deepEqual(plan.assignment, assignment);
  payload.choiceIndex = 11;
  await assert.rejects(model.plan(input), /计划不完整/);
  payload.choiceIndex = 0;
  payload.assignment = { ...assignment, objective: original };
  await assert.rejects(model.plan(input), /复制了用户原话/);
  payload.assignment = { ...assignment, deliverables: [] };
  await assert.rejects(model.plan(input), /没有生成完整任务单/);
});

test("the planner resumes the persisted manager conversation on the local runner", async () => {
  const conversation = { threadId: "00000000-0000-4000-8000-000000000001", saveThreadId() {} };
  const model = new TaskManagerModel({
    apiKey: "unused", model: "test-model", fetchImpl: async () => assert.fail("planning must stay in its Codex conversation"),
    runLocal: async (options) => {
      assert.equal(options.conversation, conversation);
      assert.match(options.instructions, /当前用户的简短回答/);
      return JSON.stringify({ type: "clarify", query: "", contextTarget: "none", choiceIndex: 0, reply: "哪个项目？" });
    },
  });
  const plan = await model.plan({ text: "cocos", context: {}, attachments: [], conversation });
  assert.equal(plan.reply, "哪个项目？");
});

test("the native runner rejects an unexpected replacement thread on resume", () => {
  const { readConversationOutput } = require("../src/infra/model/local-manager-model");
  const id = "00000000-0000-4000-8000-000000000001";
  const output = [{ type: "thread.started", thread_id: id }, { type: "item.completed", item: { type: "agent_message", text: "继续原问题" } },
    { type: "turn.completed" }].map((entry) => JSON.stringify(entry)).join("\n");
  let saved;
  assert.equal(readConversationOutput(output, { saveThreadId: (value) => { saved = value; } }), "继续原问题");
  assert.equal(saved, id);
  assert.equal(readConversationOutput(output, { threadId: id, saveThreadId: () => assert.fail("must not replace existing thread") }), "继续原问题");
  assert.throws(() => readConversationOutput(output, { threadId: "another-thread" }), /没有返回完整/);
});
