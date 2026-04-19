const { enqueueMt5Command, getMt5Events } = require('./mt5-client');

class Mt5ExecutionService {
  constructor({ userId, logger = () => {}, eventSink = () => {} }) {
    this.userId = userId;
    this.logger = logger;
    this.eventSink = eventSink;
    this.seen = new Set();
    this.lastSyncAt = 0;
    this.pendingByKey = new Map();
  }

  _markSeen(id) {
    if (!id) return;
    this.seen.add(id);
    if (this.seen.size > 500) {
      const first = this.seen.values().next().value;
      this.seen.delete(first);
    }
  }

  async enqueue(type, payload = {}, dedupeKey = null) {
    if (dedupeKey && this.pendingByKey.has(dedupeKey)) return { queued: false, reason: 'duplicate_pending' };
    const result = await enqueueMt5Command(this.userId, type, payload);
    const commandId = result?.command?.id || null;
    if (dedupeKey && commandId) this.pendingByKey.set(dedupeKey, commandId);
    this.logger(`MT5 enqueue ${type}${commandId ? ` (${commandId})` : ''}`);
    return result;
  }

  async syncEvents() {
    const events = await getMt5Events(this.userId);
    const fresh = [];
    for (const event of events) {
      const id = `${event.commandId || 'evt'}:${event.ts || ''}:${event.type || ''}`;
      if (this.seen.has(id)) continue;
      this._markSeen(id);
      if (event.commandId) {
        for (const [key, value] of this.pendingByKey.entries()) {
          if (value === event.commandId) this.pendingByKey.delete(key);
        }
      }
      fresh.push(event);
      try { this.eventSink(event); } catch (_) {}
    }
    this.lastSyncAt = Date.now();
    return fresh;
  }
}

module.exports = {
  Mt5ExecutionService
};
