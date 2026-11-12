const { randomUUID } = require("node:crypto");
const { redactSensitiveText } = require("../infra/weixin/redact");
const { readTaskProcess, processHighlights } = require("./task-process");

const POLL_INTERVAL = 5_000;
const MAX_CONCURRENT = 3;
const STATUS_LABELS = { completed: "已完成", failed: "执行失败", interrupted: "已中断" };

class TaskReports {
  constructor({ store, codex, getModel, buildReply, reportError, canReport = () => true }) {
    this.store = store;
    this.codex = codex;
    this.getModel = getModel;
    this.buildReply = buildReply;
    this.reportError = reportError;
    this.canReport = canReport;
    this.active = new Set();
  }

  start() {
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  register(message, threadId, title) {
    const marker = `[微信派活编号 ${randomUUID()}]`;
    this.store.addTaskReport(message.inboxId, threadId, {
      senderId: message.senderId,
      contextToken: message.contextToken,
      task: message.taskLabel,
      title,
      marker,
      createdAt: Date.now(),
    }, Date.now() + POLL_INTERVAL);
    return { id: message.inboxId, text: `${message.text}\n\n${marker}` };
  }

  tick() {
    try {
      const due = this.store.nextTaskReports([...this.active], MAX_CONCURRENT - this.active.size);
      for (const job of due) {
        this.active.add(job.id);
        this.process(job).catch((error) => {
          this.store.delayTaskReport(job.id, Date.now() + 30_000);
          this.reportError(error);
        }).catch(this.reportError).finally(() => this.active.delete(job.id));
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  async process(job) {
    const context = JSON.parse(job.payload);
    if (!this.canReport(context.senderId)) {
      this.store.removeTaskReport(job.id);
      return;
    }
    if (job.outcome) {
      await this.report(job, context, JSON.parse(job.outcome));
      return;
    }
    if (!this.codex.isReady) {
      this.store.delayTaskReport(job.id, Date.now() + POLL_INTERVAL, job.cursor);
      return;
    }
    const page = await this.codex.sendRequest("thread/turns/list", {
      threadId: job.thread, limit: 8, sortDirection: "desc", itemsView: "summary", ...(job.cursor && { cursor: job.cursor }),
    }, { timeoutMs: 4_000, observeTimeout: false });
    const turns = page?.result?.data || [];
    const turn = turns.find((candidate) => job.turn
      ? candidate.id === job.turn : hasTaskMarker(candidate, context.marker));
    const outcome = recordedOutcome(turn);
    if (outcome) {
      this.store.setReportOutcome(job.id, turn.id, outcome);
      return;
    }
    if (turn) this.store.setReportTurn(job.id, turn.id);
    const last = turns.at(-1)?.startedAt;
    const cursor = !turn && (!last || last * 1_000 >= context.createdAt - 5_000) ? page?.result?.nextCursor : null;
    const delay = cursor ? POLL_INTERVAL : Math.min(60_000, POLL_INTERVAL * (1 + Math.floor(job.attempts / 3)));
    this.store.delayTaskReport(job.id, Date.now() + delay, cursor === job.cursor ? null : cursor);
  }

  async report(job, context, outcome) {
    const label = STATUS_LABELS[outcome.status];
    const model = this.getModel();
    const evidence = outcome.result || "";
    let details = evidence || "原会话没有留下文字结果。";
    const snapshot = job.turn && this.codex.isReady ? await readTaskProcess(this.codex, job.thread, job.turn).catch(() => null) : null;
    const process = snapshot?.messages.some(({ role }) => role === "progress" || role === "verification") || false;
    const highlights = processHighlights(snapshot?.messages || []);
    if (highlights) details = `关键过程\n${highlights}\n\n结果\n${details}`;
    if (model.enabled && (process || evidence.length > 150 || evidence.includes("\n"))) {
      try {
        const summary = await model.summarize({
          messages: [...(process ? snapshot.messages : []), { role: "assistant", text: evidence }],
          focus: `汇报派活任务「${context.task}」的结果。执行状态为「${label}」。用简短中文报告已做事项、验证结果和未完成项，依据记录说明，避免重复标题。`,
          partial: outcome.status !== "completed",
          ...(process && { process }),
        });
        if (summary?.trim()) details = summary;
      } catch (error) {
        this.reportError(error);
      }
    }
    const text = `「${context.title}」${label}\n任务：${context.task}\n\n${details}`;
    const messages = this.buildReply(context.senderId, text, context.contextToken);
    this.store.finishTaskReport(job.id, messages, context.senderId);
  }
}

function recordedOutcome(turn) {
  if (!turn || !Object.hasOwn(STATUS_LABELS, turn.status)) return null;
  // A separate App Server can show an unfinished turn as interrupted while reading history.
  if (turn.status === "interrupted" && !(Number.isFinite(turn.completedAt) && turn.completedAt > 0)) return null;
  const lastReply = (turn.items || []).findLast((item) => item.type === "agentMessage")?.text;
  const result = redactSensitiveText(lastReply, 3_000);
  const error = redactSensitiveText(turn.error?.message, 500);
  return { status: turn.status, result: [result, error].filter(Boolean).join("\n") };
}

function hasTaskMarker(turn, marker) {
  return (turn.items || []).some((item) => item?.type === "userMessage"
    && item.content?.some((part) => part?.type === "text" && part.text?.trimEnd().endsWith(marker)));
}

module.exports = { TaskReports, STATUS_LABELS, recordedOutcome };
