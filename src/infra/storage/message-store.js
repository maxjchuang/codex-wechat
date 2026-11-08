const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

class MessageStore {
  constructor(file, accountId) {
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const descriptor = fs.openSync(file, "a", 0o600);
      fs.closeSync(descriptor);
    }
    this.db = new DatabaseSync(file);
    this.accountId = accountId;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS cursor (account TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (
        account TEXT NOT NULL, id TEXT NOT NULL, sender TEXT NOT NULL, fast INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', payload TEXT, thread TEXT, turn TEXT,
        PRIMARY KEY (account, id)
      );
      CREATE INDEX IF NOT EXISTS inbox_pending ON inbox (account, state, fast, sender);
      CREATE TABLE IF NOT EXISTS outbox (
        account TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account, id)
      );
      CREATE TABLE IF NOT EXISTS task_reports (
        account TEXT NOT NULL, id TEXT NOT NULL, thread TEXT NOT NULL, turn TEXT,
        payload TEXT NOT NULL, outcome TEXT, cursor TEXT,
        retry_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account, id)
      );
      CREATE INDEX IF NOT EXISTS task_reports_due ON task_reports (account, retry_at);
      CREATE TABLE IF NOT EXISTS task_watches (
        account TEXT NOT NULL, id TEXT NOT NULL, sender TEXT NOT NULL, thread TEXT NOT NULL, turn TEXT NOT NULL,
        payload TEXT NOT NULL, retry_at INTEGER NOT NULL, cursor TEXT, progress TEXT, progress_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account, id), UNIQUE (account, sender, thread, turn)
      );
      CREATE INDEX IF NOT EXISTS task_watches_due ON task_watches (account, retry_at);
      CREATE TABLE IF NOT EXISTS task_terminal_notices (
        account TEXT NOT NULL, sender TEXT NOT NULL, thread TEXT NOT NULL, turn TEXT NOT NULL,
        PRIMARY KEY (account, sender, thread, turn)
      );
    `);
  }

  close() {
    this.db.close();
  }

  transaction(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getCursor() {
    return this.db.prepare("SELECT value FROM cursor WHERE account = ?").get(this.accountId)?.value;
  }

  acceptBatch(cursor, messages, isFast) {
    this.transaction(() => {
      const insert = this.db.prepare("INSERT OR IGNORE INTO inbox (account, id, sender, fast, payload) VALUES (?, ?, ?, ?, ?)");
      for (const message of messages) {
        const sender = typeof message?.from_user_id === "string" ? message.from_user_id.trim() : "";
        if (!sender || Number(message.message_type) === 2) continue;
        const payload = JSON.stringify(message);
        const id = message.message_id ? String(message.message_id) : createHash("sha256").update(payload).digest("hex");
        insert.run(this.accountId, id, sender, Number(isFast(message)), payload);
      }
      if (cursor) {
        this.db.prepare("INSERT INTO cursor VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET value = excluded.value")
          .run(this.accountId, cursor);
      }
    });
  }

  nextInbox(fast, busySenders, limit) {
    if (limit <= 0) return [];
    const exclude = busySenders.length ? `AND sender NOT IN (${busySenders.map(() => "?").join(",")})` : "";
    return this.db.prepare(`
      SELECT id, sender, payload FROM inbox WHERE rowid IN (
        SELECT min(rowid) FROM inbox WHERE account = ? AND state = 'pending' AND fast = ?
        ${exclude} GROUP BY sender
      ) ORDER BY rowid LIMIT ?
    `).all(this.accountId, Number(fast), ...busySenders, limit);
  }

  claim(id) {
    return this.db.prepare("UPDATE inbox SET state = 'processing' WHERE account = ? AND id = ? AND state = 'pending'")
      .run(this.accountId, id).changes === 1;
  }

  waitForResult(id, thread = null, turn = null) {
    this.db.prepare("UPDATE inbox SET state = 'waiting', thread = ?, turn = ? WHERE account = ? AND id = ? AND state IN ('processing', 'waiting')")
      .run(thread, turn, this.accountId, id);
  }

  finishProcessing(id) {
    this.db.prepare("UPDATE inbox SET state = 'done', payload = NULL WHERE account = ? AND id = ? AND state = 'processing'")
      .run(this.accountId, id);
  }

  enqueueReplies(messages, { finishId, uncertain = false } = {}) {
    this.transaction(() => {
      if (finishId) {
        const result = this.db.prepare("UPDATE inbox SET state = ?, payload = NULL WHERE account = ? AND id = ? AND state IN ('processing', 'waiting')")
          .run(uncertain ? "uncertain" : "done", this.accountId, finishId);
        if (!result.changes) return;
      }
      this.insertReplies(messages);
    });
  }

  isWaiting(id) {
    return this.db.prepare("SELECT state FROM inbox WHERE account = ? AND id = ?").get(this.accountId, id)?.state === "waiting";
  }

  insertReplies(messages) {
    const insert = this.db.prepare("INSERT OR IGNORE INTO outbox (account, id, payload) VALUES (?, ?, ?)");
    for (const message of messages) {
      insert.run(this.accountId, message.client_id, JSON.stringify(message));
    }
  }

  recoverInterrupted(buildReplies, submittedOnly = false) {
    const predicate = submittedOnly ? "state = 'waiting' AND thread IS NOT NULL" : "state IN ('processing', 'waiting')";
    this.transaction(() => {
      const interrupted = this.db.prepare(`SELECT * FROM inbox WHERE account = ? AND ${predicate}`).all(this.accountId);
      for (const entry of interrupted) {
        this.insertReplies(buildReplies(JSON.parse(entry.payload), entry));
      }
      this.db.prepare(`UPDATE inbox SET state = 'uncertain', payload = NULL WHERE account = ? AND ${predicate}`).run(this.accountId);
    });
  }

  nextReply(now = Date.now()) {
    return this.db.prepare("SELECT id, payload, attempts FROM outbox WHERE account = ? AND retry_at <= ? ORDER BY rowid LIMIT 1")
      .get(this.accountId, now);
  }

  acknowledgeReply(id) {
    this.db.prepare("DELETE FROM outbox WHERE account = ? AND id = ?").run(this.accountId, id);
  }

  delayReply(id, retryAt) {
    this.db.prepare("UPDATE outbox SET attempts = attempts + 1, retry_at = ? WHERE account = ? AND id = ?")
      .run(retryAt, this.accountId, id);
  }

  addTaskReport(id, thread, payload, retryAt) {
    this.db.prepare("INSERT INTO task_reports (account, id, thread, payload, retry_at) VALUES (?, ?, ?, ?, ?)")
      .run(this.accountId, id, thread, JSON.stringify(payload), retryAt);
  }

  setReportTurn(id, turn) {
    this.db.prepare("UPDATE task_reports SET turn = ?, cursor = NULL WHERE account = ? AND id = ?")
      .run(turn, this.accountId, id);
  }

  setReportOutcome(id, turn, outcome) {
    this.transaction(() => {
      const updated = this.db.prepare("UPDATE task_reports SET turn = ?, outcome = ?, retry_at = 0 WHERE account = ? AND id = ? AND outcome IS NULL")
        .run(turn, JSON.stringify(outcome), this.accountId, id);
      if (updated.changes) {
        this.db.prepare("UPDATE inbox SET state = 'done', payload = NULL WHERE account = ? AND id = ? AND state IN ('processing', 'waiting', 'uncertain')")
          .run(this.accountId, id);
      }
    });
  }

  nextTaskReports(active, limit, now = Date.now()) {
    if (limit <= 0) return [];
    const exclude = active.length ? `AND id NOT IN (${active.map(() => "?").join(",")})` : "";
    return this.db.prepare(`SELECT id, thread, turn, payload, outcome, cursor, attempts FROM task_reports
      WHERE account = ? AND retry_at <= ? ${exclude} ORDER BY retry_at, rowid LIMIT ?`)
      .all(this.accountId, now, ...active, limit);
  }

  delayTaskReport(id, retryAt, cursor = null) {
    this.db.prepare("UPDATE task_reports SET retry_at = ?, cursor = ?, attempts = attempts + 1 WHERE account = ? AND id = ?")
      .run(retryAt, cursor, this.accountId, id);
  }

  removeTaskReport(id) {
    return this.db.prepare("DELETE FROM task_reports WHERE account = ? AND id = ?").run(this.accountId, id).changes;
  }

  finishTaskReport(id, messages, sender) {
    this.transaction(() => {
      const job = this.db.prepare("SELECT thread, turn FROM task_reports WHERE account = ? AND id = ?").get(this.accountId, id);
      if (!job) return;
      this.removeTaskReport(id);
      this.insertTerminalNotice(sender, job.thread, job.turn, messages);
    });
  }

  insertTerminalNotice(sender, thread, turn, messages) {
    if (!messages.length) return;
    if (!sender || !turn || this.db.prepare("INSERT OR IGNORE INTO task_terminal_notices VALUES (?, ?, ?, ?)")
      .run(this.accountId, sender, thread, turn).changes) this.insertReplies(messages);
  }

  addTaskWatch({ id, sender, thread, turn, payload, progress, retryAt }) {
    return this.db.prepare(`INSERT OR IGNORE INTO task_watches
      (account, id, sender, thread, turn, payload, progress, retry_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(this.accountId, id, sender, thread, turn, JSON.stringify(payload), progress, retryAt).changes;
  }

  listTaskWatches(sender) {
    return this.db.prepare("SELECT id, sender, thread, turn, payload FROM task_watches WHERE account = ? AND sender = ? ORDER BY rowid")
      .all(this.accountId, sender);
  }

  nextTaskWatches(active, limit, now = Date.now()) {
    if (limit <= 0) return [];
    const exclude = active.length ? `AND id NOT IN (${active.map(() => "?").join(",")})` : "";
    return this.db.prepare(`SELECT * FROM task_watches WHERE account = ? AND retry_at <= ? ${exclude} ORDER BY retry_at, rowid LIMIT ?`)
      .all(this.accountId, now, ...active, limit);
  }

  advanceTaskWatch(job, retryAt, { cursor = null, progress = job.progress, progressAt = job.progress_at, messages = [] } = {}) {
    this.transaction(() => {
      const update = this.db.prepare("UPDATE task_watches SET retry_at = ?, cursor = ?, progress = ?, progress_at = ? WHERE account = ? AND id = ?")
        .run(retryAt, cursor, progress, progressAt, this.accountId, job.id);
      if (update.changes) this.insertReplies(messages);
    });
  }

  removeTaskWatch(id) {
    return this.db.prepare("DELETE FROM task_watches WHERE account = ? AND id = ?").run(this.accountId, id).changes;
  }

  finishTaskWatch(job, messages) {
    this.transaction(() => {
      if (!this.removeTaskWatch(job.id)) return;
      const assigned = this.db.prepare(`SELECT 1 FROM task_reports WHERE account = ? AND thread = ? AND turn = ?
        AND json_extract(payload, '$.senderId') = ? LIMIT 1`).get(this.accountId, job.thread, job.turn, job.sender);
      if (!assigned) this.insertTerminalNotice(job.sender, job.thread, job.turn, messages);
    });
  }
}

module.exports = { MessageStore };
