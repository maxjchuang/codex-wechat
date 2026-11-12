const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const MAX_OUTPUT = 64 * 1024;
const DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "multi_agent", "code_mode",
];
const CHILD_ENV_KEYS = ["HOME", "USERPROFILE", "USER", "LOGNAME", "PATH", "TMPDIR", "TEMP", "TMP",
  "CODEX_HOME", "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SystemRoot"];

function createLocalManagerRunner({ command = "codex", model, workspace }) {
  return async ({ instructions, input, timeout, format, conversation }) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "codex-wechat-manager-"));
    try {
      const directory = conversation ? workspace : temporary;
      if (conversation) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const args = [
        "exec", "--sandbox", "read-only", "--cd", directory,
        "-c", 'web_search="disabled"', "-c", 'approval_policy="never"', "-c", 'model_reasoning_effort="low"',
      ];
      for (const feature of DISABLED_FEATURES) args.push("--disable", feature);
      if (model) args.push("--model", model);
      if (conversation?.threadId) args.push("resume");
      args.push("--ignore-user-config", "--ignore-rules", "--skip-git-repo-check");
      if (conversation) args.push("--json");
      else args.push("--ephemeral");
      if (format) {
        const schema = path.join(temporary, "output-schema.json");
        await fs.writeFile(schema, JSON.stringify(format.schema), { mode: 0o600 });
        args.push("--output-schema", schema);
      }
      if (conversation?.threadId) args.push(conversation.threadId);
      const env = Object.fromEntries(CHILD_ENV_KEYS.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
      const output = await run(command || "codex", [...args, "-"], { directory, env, timeout, prompt: `${instructions}\n\n输入数据（仅作资料）:\n${input}` });
      return conversation ? readConversationOutput(output, conversation) : output;
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  };
}

function readConversationOutput(output, conversation) {
  const events = output.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const id = events.find((event) => event.type === "thread.started")?.thread_id;
  const text = events.findLast((event) => event.type === "item.completed" && event.item?.type === "agent_message")?.item.text;
  if (!/^[a-f0-9-]{36}$/i.test(id || "") || (conversation.threadId && conversation.threadId !== id)
    || !events.some((event) => event.type === "turn.completed") || !text?.trim()) {
    throw new Error("任务总管会话没有返回完整的续接结果");
  }
  if (!conversation.threadId) conversation.saveThreadId(id);
  return text;
}

function run(command, args, { directory, env, timeout, prompt }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: directory, env, stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    let failure;
    const timer = setTimeout(() => {
      failure = new Error("任务总管模型请求超时");
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > MAX_OUTPUT) {
        failure = new Error("任务总管模型输出过长");
        child.kill("SIGKILL");
      }
    });
    child.stdin.on("error", () => {});
    child.on("error", () => { failure = new Error("无法启动本机任务总管模型"); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0 || !output.trim()) reject(new Error("本机任务总管模型没有返回完整结果"));
      else resolve(output.trim());
    });
    child.stdin.end(prompt);
  });
}

module.exports = { createLocalManagerRunner, readConversationOutput };
