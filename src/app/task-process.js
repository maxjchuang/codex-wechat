const { redactSensitiveText } = require("../infra/weixin/redact");

const PAGE_SIZE = 60;
const MAX_PAGES = 9;
const READ_OPTIONS = { timeoutMs: 2_000, observeTimeout: false };
const VERIFICATION_COMMAND = /(?:^|[\s'";&|])(?:--test|test|lint|check|typecheck|build|pytest|vitest|jest)(?=[:\s'";&|]|$)/i;

async function* listProcessPages(codex, threadId, turnId) {
  let cursor;
  let selectedTurn = turnId;
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const response = await codex.sendRequest("thread/items/list", {
      threadId, ...(turnId && { turnId }), limit: PAGE_SIZE, sortDirection: "desc", ...(cursor && { cursor }),
    }, READ_OPTIONS);
    const { data = [], nextCursor } = response?.result || {};
    selectedTurn ||= data[0]?.turnId;
    const rows = data.filter((row) => !selectedTurn || !row.turnId || row.turnId === selectedTurn);
    const more = rows.length === data.length && Boolean(nextCursor) && nextCursor !== cursor;
    yield { rows, truncated: more && index === MAX_PAGES - 1 };
    if (!more) return;
    cursor = nextCursor;
  }
}

async function readTaskProcess(codex, threadId, turnId) {
  const events = [];
  const counts = new Map();
  const seen = new Set();
  let truncated = false;
  try {
    for await (const page of listProcessPages(codex, threadId, turnId)) {
      truncated = page.truncated;
      for (const { item, completedAtMs, startedAtMs } of page.rows) {
        const event = processEvent(item);
        if (!event) continue;
        const key = `${event.role}: ${event.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const count = counts.get(event.role) || 0;
        const limit = { progress: 10, verification: 6, assistant: 2, user: 1 }[event.role];
        if (count >= limit) continue;
        counts.set(event.role, count + 1);
        const time = completedAtMs || startedAtMs;
        events.push({ ...event, ...(time > 0 && { at: new Date(time).toISOString() }) });
      }
    }
  } catch (error) {
    if (!events.length) throw error;
    truncated = true;
  }
  return { messages: events.reverse(), truncated };
}

function processEvent(item) {
  if (item?.type === "agentMessage") {
    const text = redactSensitiveText(item.text, 1_300);
    return text ? { role: item.phase === "commentary" ? "progress" : "assistant", text } : null;
  }
  if (item?.type === "userMessage") {
    const text = redactSensitiveText(item.content?.filter(({ type }) => type === "text").map((entry) => entry.text).join("\n")
      .replace(/\n*\[微信派活编号 [a-f0-9-]+\]\s*$/i, ""), 700);
    return text ? { role: "user", text } : null;
  }
  if (item?.type === "commandExecution" && typeof item.command === "string" && VERIFICATION_COMMAND.test(item.command)
    && Number.isInteger(item.exitCode)) {
    const command = redactSensitiveText(item.command, 230);
    const totals = String(item.aggregatedOutput || "").match(/^# (?:tests|pass|fail|skipped) \d+$/gm)?.slice(-4) || [];
    return { role: "verification", text: [command, `退出码 ${item.exitCode}`, ...totals].join("\n") };
  }
  return null;
}

function processHighlights(messages, max = 3) {
  const progress = messages.filter(({ role }) => role === "progress").slice(-max);
  const verification = messages.findLast(({ role }) => role === "verification");
  return [...progress, ...(verification ? [verification] : [])]
    .map(({ role, text }) => `• ${role === "verification" ? "验证 " : ""}${text.replace(/\s+/g, " ").slice(0, 280)}`).join("\n");
}

module.exports = { listProcessPages, readTaskProcess, processHighlights };
