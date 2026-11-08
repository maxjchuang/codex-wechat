const NORMAL_CONCURRENCY = 4;
const FAST_CONCURRENCY = 2;

class MessageDelivery {
  constructor({ store, receive, send, reportError }) {
    this.store = store;
    this.receive = receive;
    this.send = send;
    this.reportError = reportError;
    this.normalSenders = new Set();
    this.fastSenders = new Set();
    this.sending = false;
  }

  start() {
    this.timer = setInterval(() => this.tick(), 250);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  tick() {
    try {
      this.drain(true, this.fastSenders, FAST_CONCURRENCY);
      this.drain(false, this.normalSenders, NORMAL_CONCURRENCY);
      if (!this.sending) void this.flushReplies().catch(this.reportError);
    } catch (error) {
      this.reportError(error);
    }
  }

  drain(fast, busySenders, capacity) {
    for (const job of this.store.nextInbox(fast, [...busySenders], capacity - busySenders.size)) {
      if (!this.store.claim(job.id)) continue;
      busySenders.add(job.sender);
      this.run(job, busySenders).catch(this.reportError);
    }
  }

  async run(job, busySenders) {
    try {
      await this.receive(JSON.parse(job.payload), job.id);
      this.store.finishProcessing(job.id);
    } finally {
      busySenders.delete(job.sender);
    }
  }

  async flushReplies() {
    this.sending = true;
    try {
      let row;
      while ((row = this.store.nextReply())) {
        try {
          await this.send(JSON.parse(row.payload));
        } catch (error) {
          const delay = Math.min(60_000, 1_000 * (2 ** Math.min(row.attempts, 6)));
          this.store.delayReply(row.id, Date.now() + delay);
          this.reportError(error);
          continue;
        }
        this.store.acknowledgeReply(row.id);
      }
    } finally {
      this.sending = false;
    }
  }
}

module.exports = { MessageDelivery };
