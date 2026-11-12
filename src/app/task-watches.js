const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { redactSensitiveText } = require("../infra/weixin/redact");
const { STATUS_LABELS, recordedOutcome } = require("./task-reports");
const { listProcessPages, readTaskProcess, processHighlights } = require("./task-process");

const POLL_INTERVAL = 8_000;
const PROGRESS_INTERVAL = 60_000;
const MAX_CONCURRENT = 4;
const READ_OPTIONS = { timeoutMs: 4_000, observeTimeout: false };
const MILESTONE = /(?:已(?:经)?(?:完成|修复|定位|确认|找到|实现|提交|通过|跑完|验证|复现)|(?:测试|构建|验证)(?:已)?(?:通过|失败)|发现.{0,12}(?:原因|问题|回归|错误)|(?:阻塞|受阻|需要你|等你|等待审批)|\b(?:completed|fixed|identified|confirmed|blocked|tests? (?:passed|failed))\b)/i;

class TaskWatches {
  constructor({ store, codex, buildReply, canWatch, reportError }) {
    Object.assign(this, { store, codex, buildReply, canWatch, reportError });
    this.active = new Set();
  }

  start() {
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  list(sender) {
    return this.store.listTaskWatches(sender).map((row) => ({ ...row, ...JSON.parse(row.payload) }));
  }

  remove(id) {
    return this.store.removeTaskWatch(id);
  }

  cancel(sender, matches) {
    return this.store.cancelTaskWatches(sender, matches);
  }

  async inspect(thread) {
    const page = await this.readTurns(thread.id);
    const turn = page.data?.[0];
    if (!turn?.id || recordedOutcome(turn)) return null;
    if (turn.status === "inProgress") return turn;
    if (turn.status === "interrupted" && await this.codex.hasLocalThreadWriter(thread.id)) return turn;
    return null;
  }

  async register(message, thread, title, turn) {
    if (this.list(message.senderId).some(({ thread: id, turn: turnId }) => id === thread.id && turnId === turn.id)) return "existing";
    const baseline = await this.readMilestone(thread.id, turn.id).catch(() => null);
    const added = this.store.addTaskWatch({
      id: randomUUID(), sender: message.senderId, thread: thread.id, turn: turn.id,
      payload: { title, cwd: thread.cwd, contextToken: message.contextToken },
      progress: JSON.stringify({ item: baseline?.milestone?.id || null, head: baseline?.head || null, waiting: null }), retryAt: Date.now(),
    });
    return added ? "added" : "existing";
  }

  tick() {
    if (!this.codex.isReady) return;
    try {
      for (const job of this.store.nextTaskWatches([...this.active], MAX_CONCURRENT - this.active.size)) {
        this.active.add(job.id);
        this.process(job).catch((error) => {
          this.store.advanceTaskWatch(job, Date.now() + 30_000, { cursor: job.cursor });
          this.reportError(error);
        }).catch(this.reportError).finally(() => this.active.delete(job.id));
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  async process(job) {
    const context = JSON.parse(job.payload);
    if (!await this.canWatch(job.sender, job.thread, context.cwd)) {
      this.remove(job.id);
      return;
    }
    const page = await this.readTurns(job.thread, job.cursor);
    const project = path.basename(context.cwd);
    const heading = `「${context.title}」`;
    const projectLine = project && project !== context.title ? `\n项目：${project}` : "";
    const turn = page.data?.find(({ id }) => id === job.turn);
    const outcome = recordedOutcome(turn);
    if (outcome) {
      const details = outcome.result || "原会话没有留下文字结果。";
      const evidence = await readTaskProcess(this.codex, job.thread, job.turn).catch(() => null);
      const highlights = processHighlights(evidence?.messages || []);
      this.store.finishTaskWatch(job, this.buildReply(job.sender,
        `${heading}${STATUS_LABELS[outcome.status]}${projectLine}\n\n${highlights ? `关键过程\n${highlights}\n\n结果\n` : ""}${details}`, context.contextToken));
      return;
    }
    if (!turn) {
      const cursor = page.nextCursor && page.nextCursor !== job.cursor ? page.nextCursor : null;
      this.store.advanceTaskWatch(job, Date.now() + POLL_INTERVAL, { cursor });
      return;
    }
    const now = Date.now();
    if (now - job.progress_at >= PROGRESS_INTERVAL) {
      const previous = job.progress ? JSON.parse(job.progress) : {};
      const status = !job.cursor && page.data?.[0]?.id === turn.id && turn.status === "inProgress"
        ? await this.readWaitingStatus(job.thread).catch(() => undefined) : null;
      const changedStatus = status && status.id !== previous.waiting ? status : null;
      const scan = changedStatus ? null : await this.readMilestone(job.thread, turn.id, previous.head);
      const milestone = scan?.milestone;
      const newMilestone = Object.hasOwn(previous, "head") && milestone?.id !== previous.item ? milestone : null;
      const update = changedStatus || newMilestone;
      const progress = JSON.stringify({ item: milestone?.id || previous.item, head: scan?.head || previous.head || null,
        waiting: status === undefined ? previous.waiting : status?.id || null });
      if (update?.text) {
        const messages = this.buildReply(job.sender, `${heading}有新进展${projectLine}\n\n${update.text}`, context.contextToken);
        this.store.advanceTaskWatch(job, now + POLL_INTERVAL, { progress, progressAt: now, messages });
        return;
      }
      this.store.advanceTaskWatch(job, now + POLL_INTERVAL, { progress });
      return;
    }
    this.store.advanceTaskWatch(job, now + POLL_INTERVAL);
  }

  async readTurns(threadId, cursor) {
    const response = await this.codex.sendRequest("thread/turns/list", {
      threadId, limit: 8, sortDirection: "desc", itemsView: "summary", ...(cursor && { cursor }),
    }, READ_OPTIONS);
    return response?.result || {};
  }

  async readWaitingStatus(threadId) {
    const response = await this.codex.sendRequest("thread/read", { threadId, includeTurns: false }, READ_OPTIONS);
    const flags = response?.result?.thread?.status?.activeFlags || [];
    if (flags.includes("waitingOnApproval")) return { id: "waitingOnApproval", text: "当前任务正在原会话等待审批。" };
    if (flags.includes("waitingOnUserInput")) return { id: "waitingOnUserInput", text: "当前任务正在原会话等你补充信息。" };
    return null;
  }

  async readMilestone(threadId, turnId, previousHead) {
    let head;
    for await (const { rows } of listProcessPages(this.codex, threadId, turnId)) {
      head ||= rows[0]?.item?.id;
      for (const { item } of rows) {
        if (!item?.id) continue;
        if (item.id === previousHead) return { head };
        if (item.type === "agentMessage" && item.phase === "commentary" && typeof item.text === "string" && MILESTONE.test(item.text)) {
          return { head, milestone: { id: item.id, text: redactSensitiveText(item.text, 800) } };
        }
      }
    }
    return { head };
  }
}

module.exports = { TaskWatches };
