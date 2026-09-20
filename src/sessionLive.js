import {
  delegateLiveTask,
  flushLiveTranscript,
  negotiateLiveSession,
  persistLiveEvents,
  sendSessionChat,
} from "./liveApi.js";

const AUDIO_CONSTRAINTS = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const APPEND_TYPES = new Set(["session.instructions.append", "session.thinking.append", "session.commentary.append"]);
const CALLBACKS = ["onStateChange", "onStatus", "onEvent", "onError", "onUserTranscriptPartial", "onPartnerTranscriptPartial", "onSnapshot", "onToolResult", "onBackendStatus", "onMutedChange", "onUsage", "onActivity"];
const id = () => `live_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
const aborted = () => new DOMException("Voice connection was cancelled", "AbortError");
const errorFrom = (value) => value instanceof Error ? value : Object.assign(new Error(value?.error?.message ?? value?.message ?? "Voice connection failed"), { code: value?.error?.code ?? value?.code });

function conciseContext(text) {
  // UTF-8 bytes also bound the tokenizer's byte-level fallback, including for
  // non-Latin text. Full selected and typed text stays in the canonical session.
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const length = new TextEncoder().encode(character).length;
    if (bytes + length > 480) break;
    result += character;
    bytes += length;
  }
  return result;
}

function waitFor(target, type, ready, { timeoutMs, signal, message }) {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      target.removeEventListener?.(type, check);
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve();
    };
    const check = () => { if (ready()) finish(); };
    const cancel = () => finish(aborted());
    const timer = setTimeout(() => finish(new Error(message)), timeoutMs);
    target.addEventListener?.(type, check);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    else check();
  });
}

/** Display grouping only. The original events remain immutable and never imply semantic completion. */
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
    // Preserve delivery order and exact whitespace, including repeated words.
    row.text += event.delta;
  }
  return rows;
}

/**
 * One canonical session's browser voice transport. Server endpoints own transcript
 * commitment and map changes. No legacy transcript-final callback is invoked.
 *
 * connect() requests microphone access. end() waits for session.closed, then saves
 * remaining fragments. disconnect() is immediate component-unmount cleanup.
 * sendText() works with or without voice and commits through /chat exactly once.
 * UI callbacks: onSnapshot(snapshot), onBackendStatus({state,delegationId}),
 * onMutedChange({muted,pending}), and independent partial-caption callbacks.
 */
export class SessionLiveClient {
  constructor(options = {}) {
    if (!options.sessionId) throw new TypeError("A session ID is required");
    this.sessionId = options.sessionId;
    this.audioElement = options.audioElement ?? null;
    this.mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
    this.peerConnectionFactory = options.peerConnectionFactory ?? (() => new globalThis.RTCPeerConnection());
    this.audioContextFactory = options.audioContextFactory ?? (() => {
      const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      return AudioContext ? new AudioContext() : null;
    });
    this.getSelectedContext = options.getSelectedContext;
    this.api = { negotiateLiveSession, persistLiveEvents, flushLiveTranscript, delegateLiveTask, sendSessionChat, ...options.api };
    this.timeouts = { setup: 20_000, command: 10_000, close: 5000, reconnect: 3500, ...options.timeouts };
    this.batchMs = options.batchMs ?? 500;
    this.callbacks = { ...options.callbacks };
    CALLBACKS.forEach((name) => { if (options[name]) this.callbacks[name] = options[name]; });
    try { this.storage = options.storage === undefined ? globalThis.localStorage : options.storage; } catch { this.storage = null; }
    this.storageKey = `thoughtform:live-outbox:${this.sessionId}`;
    this._outbox = this._loadOutbox();
    this._state = "idle";
    this._generation = 0;
    this._muted = false;
    this._desiredMuted = false;
    this._started = false;
    this._liveSessionId = null;
    this._waiters = new Map();
    this._delegations = new Map();
    this._seenEvents = new Set();
    this._captionFragments = [];
    this._captionLiveIds = new WeakMap();
    this._pendingIds = null;
    this._context = null;
    this._lastContext = null;
    this._usage = null;
    this._ending = null;
    this._retryCount = 0;
  }

  get connectionState() { return this._state; }
  get connected() { return this._state === "connected" && this._started && this._channel?.readyState === "open"; }
  get muted() { return this._muted; }
  get liveSessionId() { return this._liveSessionId; }

  _setState(state, detail = null) {
    this._state = state;
    this.callbacks.onStateChange?.({ state, detail, connected: this.connected });
    this.callbacks.onStatus?.(state, detail);
  }

  _report(error, phase) {
    const normalized = errorFrom(error);
    this.callbacks.onError?.(normalized, { phase });
    return normalized;
  }

  _loadOutbox() {
    try {
      const records = JSON.parse(this.storage?.getItem(this.storageKey) ?? "[]");
      return Array.isArray(records) ? records.filter((record) => record.liveSessionId && record.event?.event_id) : [];
    } catch { return []; }
  }

  _saveOutbox() {
    try {
      if (this._outbox.length) this.storage?.setItem(this.storageKey, JSON.stringify(this._outbox));
      else this.storage?.removeItem(this.storageKey);
    } catch (error) {
      this._report(new Error("Unsaved voice fragments could not be cached in this browser. Keep this page open until saving recovers.", { cause: error }), "transcript_storage");
    }
  }

  _applyResult(result) {
    if (result?.snapshot) this.callbacks.onSnapshot?.(result.snapshot);
    this.callbacks.onToolResult?.({ result });
    if (Array.isArray(result?.pending_fragment_ids)) {
      this._pendingIds = new Set(result.pending_fragment_ids);
      // Unacknowledged newer events must stay visible when an older batch returns.
      const outstanding = new Set(this._outbox.map((record) => `${record.liveSessionId}:${record.event.event_id}`));
      this._captionFragments = this._captionFragments.filter((event) => {
        const fragmentId = `${this._captionLiveIds.get(event)}:${event.event_id}`;
        return this._pendingIds.has(fragmentId) || outstanding.has(fragmentId);
      });
      this._emitCaptions();
    }
  }

  async connect(options = {}) {
    if (this.connected) return this;
    if (["requesting_microphone", "connecting", "ending"].includes(this._state)) throw new Error("A voice connection is already changing");
    if (!this.mediaDevices?.getUserMedia) throw new Error("Microphone capture is not available in this browser");
    this._cleanupTransport();
    const generation = ++this._generation;
    this._abort = new AbortController();
    const signal = this._abort.signal;
    this._started = false;
    this._seenEvents.clear();
    this._delegations.clear();
    this._lastContext = null;
    this._ending = null;
    this._lastOptions = options;
    try {
      // Replay original IDs before replacement history is constructed by the server.
      await this.flushEvents();
      if (generation !== this._generation) throw aborted();
      this._setState("requesting_microphone");
      const stream = await this.mediaDevices.getUserMedia({ audio: options.audioConstraints ?? AUDIO_CONSTRAINTS });
      if (generation !== this._generation) { stream.getTracks().forEach((track) => track.stop()); throw aborted(); }
      this._stream = stream;
      const peer = this.peerConnectionFactory();
      this._peer = peer;
      this._setState("connecting");
      this.audioElement ??= typeof globalThis.Audio === "function" ? new globalThis.Audio() : null;
      if (this.audioElement) { this.audioElement.autoplay = true; this.audioElement.playsInline = true; }
      peer.ontrack = (event) => {
        if (generation !== this._generation || !this.audioElement) return;
        this.audioElement.srcObject = event.streams?.[0] ?? new globalThis.MediaStream([event.track]);
        this.audioElement.play?.()?.catch((error) => this._report(error, "audio_playback"));
      };
      peer.onconnectionstatechange = () => this._connectionChanged(generation);
      for (const track of stream.getAudioTracks()) { track.enabled = !this._desiredMuted; peer.addTrack(track, stream); }
      const channel = peer.createDataChannel("oai-events");
      this._channel = channel;
      channel.addEventListener("message", (event) => { void this._receiveEvent(event, generation); });
      channel.addEventListener("close", () => { if (generation === this._generation && this._state !== "ending") this._scheduleRecovery(); });
      channel.addEventListener("error", (event) => { if (generation === this._generation) this._report(event, "data_channel"); });
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitFor(peer, "icegatheringstatechange", () => peer.iceGatheringState === "complete", {
        timeoutMs: this.timeouts.setup, signal, message: "Could not finish gathering voice network candidates",
      });
      const result = await this.api.negotiateLiveSession(this.sessionId, peer.localDescription.sdp, { signal });
      if (generation !== this._generation) throw aborted();
      this._liveSessionId = result.session.id;
      this._applyResult(result);
      await peer.setRemoteDescription({ type: "answer", sdp: result.transport.sdp });
      await waitFor(channel, "open", () => channel.readyState === "open", { timeoutMs: this.timeouts.setup, signal, message: "The voice data channel did not open" });
      await waitFor(channel, "message", () => this._started, { timeoutMs: this.timeouts.setup, signal, message: "The voice session did not start" });
      if (generation !== this._generation) throw aborted();
      this._setState("connected", { liveSessionId: this._liveSessionId });
      this._startActivityMonitor(generation);
      if (this._desiredMuted) await this.setMuted(true);
      const context = this.getSelectedContext?.() ?? this._context;
      if (context) this.updateContext(context);
      return this;
    } catch (error) {
      if (generation === this._generation) {
        this._cleanupTransport();
        this._setState(error?.name === "AbortError" ? "closed" : "failed");
        if (error?.name !== "AbortError") this._report(error, "connect");
      }
      throw error;
    }
  }

  _connectionChanged(generation) {
    if (generation !== this._generation || this._state === "ending") return;
    const state = this._peer?.connectionState;
    if (state === "connected" && this._started) {
      clearTimeout(this._recoveryTimer);
      this._recoveryTimer = null;
      this._retryCount = 0;
      this._setState("connected");
    } else if (state === "disconnected" || state === "failed") this._scheduleRecovery();
  }

  _scheduleRecovery() {
    if (this._recoveryTimer || !this._started || this._state === "ending" || this._state === "closed") return;
    this._setState("reconnecting");
    const generation = this._generation;
    this._recoveryTimer = setTimeout(async () => {
      this._recoveryTimer = null;
      if (generation !== this._generation) return;
      if (this._retryCount >= 2) {
        this._cleanupTransport();
        this._setState("failed");
        this._report(new Error("Voice could not reconnect. Your saved conversation is available; reconnect when ready."), "reconnect");
        return;
      }
      this._retryCount += 1;
      try { await this.reconnect(); } catch { /* connect reports the actual failure. */ }
    }, this.timeouts.reconnect);
  }

  async reconnect() {
    // Close the prior service session before constructing replacement history.
    // This also fences late delegated work and stops old microphone capture.
    if (this._started) await this.end();
    else { await this.flushEvents(); this._cleanupTransport(); }
    this._setState("reconnecting");
    return this.connect(this._lastOptions ?? {});
  }

  _cleanupTransport() {
    this._generation += 1;
    this._abort?.abort();
    this._abort = null;
    clearTimeout(this._recoveryTimer);
    clearTimeout(this._contextTimer);
    clearTimeout(this._persistRetryTimer);
    this._persistRetryTimer = null;
    clearInterval(this._activityTimer);
    this._recoveryTimer = null;
    this._waiters.forEach(({ reject, timer }) => { clearTimeout(timer); reject(aborted()); });
    this._waiters.clear();
    this._audioContext?.close?.()?.catch?.(() => {});
    this._audioContext = null;
    if (this._peer) { this._peer.ontrack = null; this._peer.onconnectionstatechange = null; }
    try { this._channel?.close(); } catch { /* Already closed. */ }
    try { this._peer?.close(); } catch { /* Already closed. */ }
    this._stream?.getTracks().forEach((track) => track.stop());
    this._stream = null;
    this._peer = null;
    this._channel = null;
    this._started = false;
    if (this.audioElement) this.audioElement.srcObject = null;
    this.callbacks.onBackendStatus?.({ state: "idle" });
  }

  disconnect({ state = "closed" } = {}) {
    if (this._started && this._channel?.readyState === "open") {
      try { this._send({ type: "session.close" }); } catch { /* Best effort on unmount; no finalized claim. */ }
    }
    this._cleanupTransport();
    clearTimeout(this._batchTimer);
    this._batchTimer = null;
    void this.flushEvents().catch((error) => this._report(error, "transcript_save"));
    this._setState(state);
  }

  close() { return this.end(); }

  async end() {
    if (this._ending) return this._ending;
    if (!this._started) { this.disconnect(); return { finalized: false }; }
    const liveId = this._liveSessionId;
    this._setState("ending");
    this._stream?.getAudioTracks().forEach((track) => { track.enabled = false; });
    this._ending = (async () => {
      let finalized = false;
      try {
        await this._command({ type: "session.close" }, "session.closed", this.timeouts.close);
        finalized = true;
      } catch (error) {
        if (error?.name !== "AbortError") this._report(new Error("Voice stopped before the service confirmed finalization. Received transcript fragments are still being saved.", { cause: error }), "close");
      }
      try {
        await this.flushEvents();
        this._applyResult(await this.api.flushLiveTranscript(this.sessionId, liveId, { ended: true }));
      } catch (error) { this._report(error, "transcript_save"); }
      this._cleanupTransport();
      this._setState("closed", { finalized });
      return { finalized, usage: this._usage };
    })();
    return this._ending;
  }

  _send(event) {
    if (!this._started || this._channel?.readyState !== "open") throw new Error("Voice is not connected");
    const command = { event_id: id(), ...event };
    this._channel.send(JSON.stringify(command));
    return command.event_id;
  }

  _command(event, acknowledgment, timeoutMs = this.timeouts.command) {
    const eventId = event.event_id ?? id();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._waiters.delete(eventId); reject(new Error("The voice service did not acknowledge the command")); }, timeoutMs);
      this._waiters.set(eventId, { resolve, reject, acknowledgment, timer });
      try { this._send({ ...event, event_id: eventId }); } catch (error) { clearTimeout(timer); this._waiters.delete(eventId); reject(error); }
    });
  }

  async setMuted(muted) {
    this._desiredMuted = Boolean(muted);
    if (!this.connected) throw new Error("Voice is not connected");
    const generation = this._generation;
    const requested = this._desiredMuted;
    const commandId = id();
    this._muteCommandId = commandId;
    // Stop local capture immediately on mute, resume only after server acceptance.
    if (requested) this._stream?.getAudioTracks().forEach((track) => { track.enabled = false; });
    this.callbacks.onMutedChange?.({ muted: this._muted, pending: true, requested });
    try {
      await this._command({ type: requested ? "session.input_audio.mute" : "session.input_audio.unmute", event_id: commandId }, requested ? "session.input_audio.muted" : "session.input_audio.unmuted");
      if (generation !== this._generation || this._muteCommandId !== commandId) return this._muted;
      this._muted = requested;
      this._stream?.getAudioTracks().forEach((track) => { track.enabled = !requested; });
      this.callbacks.onMutedChange?.({ muted: requested, pending: false });
      if (requested) this.reportActivity(false);
      return this._muted;
    } catch (error) {
      if (generation === this._generation && this._muteCommandId === commandId) {
        this.callbacks.onMutedChange?.({ muted: this._muted, pending: false, captureMuted: requested || this._muted });
        this._report(error, "microphone_command");
      }
      throw error;
    }
  }

  _queueEvent(event) {
    if (!this._liveSessionId || this._outbox.some((record) => record.liveSessionId === this._liveSessionId && record.event.event_id === event.event_id)) return;
    this._outbox.push({ liveSessionId: this._liveSessionId, event });
    this._saveOutbox();
    if (!this._batchTimer) this._batchTimer = setTimeout(() => {
      this._batchTimer = null;
      void this.flushEvents().then(() => this._retryDelegations()).catch((error) => this._report(error, "transcript_save"));
    }, this.batchMs);
  }

  async flushEvents() {
    if (this._persisting) return this._persisting;
    clearTimeout(this._batchTimer);
    this._batchTimer = null;
    this._persisting = (async () => {
      while (this._outbox.length) {
        const liveId = this._outbox[0].liveSessionId;
        const records = this._outbox.filter((record) => record.liveSessionId === liveId).slice(0, 100);
        const result = await this.api.persistLiveEvents(this.sessionId, liveId, records.map((record) => record.event));
        const acceptedIds = new Set(result?.acknowledged_event_ids ?? records.map((record) => record.event.event_id));
        const acknowledged = new Set(records.filter((record) => acceptedIds.has(record.event.event_id)));
        if (!acknowledged.size) throw new Error("The session server did not acknowledge the saved voice fragments");
        this._outbox = this._outbox.filter((record) => !acknowledged.has(record));
        this._saveOutbox();
        this._applyResult(result);
      }
    })();
    try {
      const result = await this._persisting;
      this._persistFailures = 0;
      clearTimeout(this._persistRetryTimer);
      this._persistRetryTimer = null;
      return result;
    } catch (error) {
      this._persistFailures = (this._persistFailures ?? 0) + 1;
      if (!this._persistRetryTimer && this._state !== "closed" && this._persistFailures <= 5) {
        this._persistRetryTimer = setTimeout(() => {
          this._persistRetryTimer = null;
          void this.flushEvents().then(() => this._retryDelegations()).catch((failure) => this._report(failure, "transcript_save"));
        }, Math.min(1000 * 2 ** (this._persistFailures - 1), 10_000));
      }
      throw error;
    } finally { this._persisting = null; }
  }

  _emitCaptions() {
    const rows = groupLiveTranscriptFragments(this._captionFragments);
    for (const [speaker, callback] of [["you", "onUserTranscriptPartial"], ["partner", "onPartnerTranscriptPartial"]]) {
      const row = rows.findLast((candidate) => candidate.speaker === speaker);
      this.callbacks[callback]?.({ text: row?.text ?? "", rowId: row?.id ?? null, fragments: row?.fragments ?? [], rows: rows.filter((candidate) => candidate.speaker === speaker) });
    }
  }

  async _receiveEvent(message, generation = this._generation) {
    if (generation !== this._generation) return;
    let event;
    try { event = typeof message.data === "string" ? JSON.parse(message.data) : message.data; }
    catch (error) { this._report(error, "event_parse"); return; }
    if (!event?.type) return;
    this.callbacks.onEvent?.(event);
    if (event.type === "session.started") {
      if (event.session?.id && this._liveSessionId && event.session.id !== this._liveSessionId) return;
      this._started = true;
      return;
    }
    const clientId = event.client_event_id ?? event.error?.client_event_id;
    const waiter = this._waiters.get(clientId)
      ?? (event.type === "session.closed" ? [...this._waiters.values()].find((candidate) => candidate.acknowledgment === "session.closed") : null);
    if (waiter && (event.type === waiter.acknowledgment || event.type === "error")) {
      clearTimeout(waiter.timer);
      for (const [key, value] of this._waiters) { if (value === waiter) this._waiters.delete(key); }
      if (event.type === "error") waiter.reject(errorFrom(event)); else waiter.resolve(event);
    }
    if (event.type === "error") { this._report(event, "live_command"); return; }
    if (event.type === "session.usage.updated" || event.type === "session.closed") {
      if (event.usage) { this._usage = event.usage; this.callbacks.onUsage?.(event.usage); }
    }
    if (event.event_id && this._seenEvents.has(event.event_id)) return;
    if (event.event_id) this._seenEvents.add(event.event_id);
    if (event.type === "session.input_transcript.delta" || event.type === "session.output_transcript.delta") {
      if (!event.event_id || typeof event.delta !== "string" || !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms)) {
        this._report(new Error("The voice service returned a transcript fragment without its original identity or timing"), "transcript_format");
        return;
      }
      this._captionFragments.push(event);
      this._captionLiveIds.set(event, this._liveSessionId);
      this._emitCaptions();
      this._queueEvent(event);
    } else if (event.type === "session.delegation.created" && event.delegation?.target === "client" && event.delegation.id) {
      if (!this._delegations.has(event.delegation.id)) {
        this._delegations.set(event.delegation.id, { event, generation, state: "pending" });
        void this._runDelegation(event.delegation.id);
      }
    } else if (event.type === "session.closed") {
      this._queueEvent(event);
      if (this._state !== "ending") {
        this._cleanupTransport();
        this._setState("closed", { finalized: true, reason: event.reason });
        void this.flushEvents().catch((error) => this._report(error, "transcript_save"));
      }
    }
  }

  async _runDelegation(delegationId) {
    const entry = this._delegations.get(delegationId);
    if (!entry || entry.state !== "pending" || entry.generation !== this._generation) return;
    entry.state = "working";
    this.callbacks.onBackendStatus?.({ state: "working", delegationId });
    try {
      await this.flushEvents();
      if (entry.generation !== this._generation || this._state === "ending") return;
      const result = await this.api.delegateLiveTask(this.sessionId, this._liveSessionId, entry.event, { signal: this._abort?.signal });
      if (entry.generation !== this._generation || this._state === "ending") return;
      this._applyResult(result);
      if (result.pending) { entry.state = "pending"; return; }
      for (const event of result.events ?? []) {
        if (!APPEND_TYPES.has(event.type) || typeof event.content !== "string" || event.delegation_id !== delegationId) {
          throw new Error("The delegated result did not match its voice task");
        }
        await this._command(event, event.type.replace(/\.append$/, ".appended"));
        if (entry.generation !== this._generation || this._state === "ending") return;
      }
      entry.state = "done";
      this.callbacks.onBackendStatus?.({ state: "idle", delegationId });
    } catch (error) {
      if (entry.generation !== this._generation || error?.name === "AbortError") return;
      entry.state = "failed";
      this.callbacks.onBackendStatus?.({ state: "failed", delegationId });
      this._report(error, "delegation");
    }
  }

  _retryDelegations() {
    for (const [delegationId, entry] of this._delegations) if (entry.state === "pending") void this._runDelegation(delegationId);
  }

  updateContext(context) {
    this._context = context;
    clearTimeout(this._contextTimer);
    if (!this.connected) return;
    const generation = this._generation;
    this._contextTimer = setTimeout(() => {
      if (generation !== this._generation || !this.connected) return;
      const selected = this._context?.selectedNodeIds ?? [];
      const proposal = this._context?.selectedProposalId;
      const text = this._context?.selectedText;
      const summary = conciseContext(proposal
        ? `Current selection is an unaccepted proposal. Previous selection is replaced. Discussing it does not accept it. Reference content: ${JSON.stringify(text ?? "")}`
        : selected.length
          ? `Current map selection: ${selected.length} thought${selected.length === 1 ? "" : "s"}. Previous selection is replaced. Selection alone does not authorize a map change. Reference content: ${JSON.stringify(text ?? "")}`
          : "No map thought or proposal is selected now. Previous selection is cleared.");
      if (summary === this._lastContext) return;
      this._lastContext = summary;
      void this._command({ type: "session.thinking.append", delegation_id: null, content: summary }, "session.thinking.appended")
        .catch((error) => { if (generation === this._generation) { this._lastContext = null; this._report(error, "selection_context"); } });
    }, 200);
  }

  async sendText(text, { requestId = id() } = {}) {
    const result = await this.api.sendSessionChat(this.sessionId, text, { requestId });
    this._applyResult(result);
    // Client delegation has no conversation.item.create. Typed conversation goes
    // directly to Terra, with a brief factual update to an active voice frontend.
    if (this.connected) {
      const content = conciseContext(`Reference data from typed conversation. User: ${JSON.stringify(text)}. Partner: ${JSON.stringify(result.reply ?? "")}`);
      void this._command({ type: "session.thinking.append", delegation_id: null, content }, "session.thinking.appended")
        .catch((error) => this._report(error, "typed_context"));
    }
    return result;
  }

  reportActivity(active) {
    if (!this._liveSessionId || !this._started || this._activity === Boolean(active)) return;
    this._activity = Boolean(active);
    const activity = { active: this._activity, at_ms: Date.now() };
    this.callbacks.onActivity?.(activity);
    const liveId = this._liveSessionId;
    const generation = this._generation;
    const saved = activity.active ? Promise.resolve() : this.flushEvents();
    void saved.then(() => this.api.flushLiveTranscript(this.sessionId, liveId, { activity }))
      .then((result) => { if (generation === this._generation) { this._applyResult(result); this._retryDelegations(); } })
      .catch((error) => this._report(error, "transcript_capture"));
  }

  _startActivityMonitor(generation) {
    try {
      const context = this.audioContextFactory();
      if (!context) return;
      this._audioContext = context;
      const source = context.createMediaStreamSource(this._stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let lastSound = 0;
      this._activity = false;
      void context.resume?.()?.catch?.(() => {});
      this._activityTimer = setInterval(() => {
        if (generation !== this._generation || this._desiredMuted) return;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        if (rms > 0.018) { lastSound = Date.now(); this.reportActivity(true); }
        else if (this._activity && Date.now() - lastSound >= 900) this.reportActivity(false);
      }, 100);
    } catch {
      // Audio activity is only an extra classifier hint. Transcript saving does
      // not depend on browser audio analysis and never treats absent text as silence.
    }
  }
}

export function createSessionLiveClient(options) { return new SessionLiveClient(options); }
