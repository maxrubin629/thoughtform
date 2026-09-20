/** Display grouping only. Original fragments never imply semantic completion. */
export function groupLiveTranscriptFragments(events, gapMs = 4000) {
  const rows = [];
  const seen = new Set();
  for (const event of events) {
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    const speaker = event.type === "session.input_transcript.delta" ? "you" : "partner";
    let row = rows.findLast((candidate) => candidate.speaker === speaker
      && event.start_ms <= candidate.end_ms + gapMs && event.end_ms >= candidate.start_ms - gapMs);
    if (!row) {
      row = { id: event.event_id, speaker, start_ms: event.start_ms, end_ms: event.end_ms, fragments: [], text: "" };
      rows.push(row);
    }
    row.fragments.push(event);
    row.start_ms = Math.min(row.start_ms, event.start_ms);
    row.end_ms = Math.max(row.end_ms, event.end_ms);
    row.text += event.delta; // Preserve delivery order, whitespace, and repeated words.
  }
  return rows;
}

/** Durable original-event outbox and transient captions, independent of WebRTC. */
export class LiveTranscript {
  constructor({ sessionId, storage, persist, onResult, onSaved, onError, callbacks, shouldRetry, batchMs }) {
    this.storageKey = `thoughtform:live-outbox:${sessionId}`;
    try { this.storage = storage === undefined ? globalThis.localStorage : storage; } catch { this.storage = null; }
    Object.assign(this, { persist, onResult, onSaved, onError, callbacks, shouldRetry, batchMs });
    try {
      const records = JSON.parse(this.storage?.getItem(this.storageKey) ?? "[]");
      this.outbox = Array.isArray(records) ? records.filter((record) => record.liveSessionId && record.event?.event_id) : [];
    } catch { this.outbox = []; }
    this.fragments = [];
    this.fragmentSessions = new WeakMap();
    this.failures = 0;
  }

  save() {
    try {
      if (this.outbox.length) this.storage?.setItem(this.storageKey, JSON.stringify(this.outbox));
      else this.storage?.removeItem(this.storageKey);
    } catch (cause) {
      this.onError(new Error("Unsaved voice fragments could not be cached in this browser. Keep this page open until saving recovers.", { cause }), "transcript_storage");
    }
  }

  append(event, liveSessionId) {
    this.fragments.push(event);
    this.fragmentSessions.set(event, liveSessionId);
    this.emitCaptions();
    this.queue(event, liveSessionId);
  }

  queue(event, liveSessionId) {
    if (!liveSessionId || this.outbox.some((record) => record.liveSessionId === liveSessionId && record.event.event_id === event.event_id)) return;
    this.outbox.push({ liveSessionId, event });
    this.save();
    this.batchTimer ??= setTimeout(() => {
      this.batchTimer = null;
      this.flushInBackground();
    }, this.batchMs);
  }

  reconcile(result) {
    if (!Array.isArray(result?.pending_fragment_ids)) return;
    const visible = new Set(result.pending_fragment_ids);
    // An older response cannot clear newer, unacknowledged captions.
    for (const { liveSessionId, event } of this.outbox) visible.add(`${liveSessionId}:${event.event_id}`);
    this.fragments = this.fragments.filter((event) => visible.has(`${this.fragmentSessions.get(event)}:${event.event_id}`));
    this.emitCaptions();
  }

  emitCaptions() {
    const rows = groupLiveTranscriptFragments(this.fragments);
    for (const [speaker, callback] of [["you", "onUserTranscriptPartial"], ["partner", "onPartnerTranscriptPartial"]]) {
      const speakerRows = rows.filter((candidate) => candidate.speaker === speaker);
      const row = speakerRows.at(-1);
      this.callbacks[callback]?.({ text: row?.text ?? "", rowId: row?.id ?? null, fragments: row?.fragments ?? [], rows: speakerRows });
    }
  }

  stopRetries() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  flushInBackground() {
    void this.flush().then(this.onSaved).catch((error) => this.onError(error, "transcript_save"));
  }

  async flush() {
    if (this.flushing) return this.flushing;
    clearTimeout(this.batchTimer);
    this.batchTimer = null;
    this.flushing = this.drain();
    try {
      await this.flushing;
      this.failures = 0;
      this.stopRetries();
    } catch (error) {
      this.failures += 1;
      if (!this.retryTimer && this.shouldRetry() && this.failures <= 5) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.flushInBackground();
        }, Math.min(1000 * 2 ** (this.failures - 1), 10_000));
      }
      throw error;
    } finally { this.flushing = null; }
  }

  async drain() {
    while (this.outbox.length) {
      const liveId = this.outbox[0].liveSessionId;
      const records = this.outbox.filter((record) => record.liveSessionId === liveId).slice(0, 100);
      const result = await this.persist(liveId, records.map((record) => record.event));
      const acceptedIds = new Set(result?.acknowledged_event_ids ?? records.map((record) => record.event.event_id));
      const acknowledged = new Set(records.filter((record) => acceptedIds.has(record.event.event_id)));
      if (!acknowledged.size) throw new Error("The session server did not acknowledge the saved voice fragments");
      this.outbox = this.outbox.filter((record) => !acknowledged.has(record));
      this.save();
      this.onResult(result);
    }
  }
}
