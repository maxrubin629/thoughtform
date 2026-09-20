import {
  delegateLiveTask,
  flushLiveTranscript,
  negotiateLiveSession,
  persistLiveEvents,
  sendSessionChat,
} from "./liveApi.js";
import { aborted, conciseContext, errorFrom, eventId as id, waitFor } from "./live/protocol.js";
import { LiveTranscript } from "./live/transcript.js";

const AUDIO_CONSTRAINTS = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const APPEND_TYPES = new Set(["session.instructions.append", "session.thinking.append", "session.commentary.append"]);
const CALLBACKS = ["onStateChange", "onStatus", "onEvent", "onError", "onUserTranscriptPartial", "onPartnerTranscriptPartial", "onSnapshot", "onToolResult", "onBackendStatus", "onMutedChange", "onUsage", "onActivity"];
const EVENT_HANDLERS = new Map([
  ["session.input_transcript.delta", "_receiveTranscript"],
  ["session.output_transcript.delta", "_receiveTranscript"],
  ["session.delegation.created", "_receiveDelegation"],
  ["session.closed", "_receiveClosed"],
]);

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
    this.callbacks = { ...options.callbacks };
    CALLBACKS.forEach((name) => { if (options[name]) this.callbacks[name] = options[name]; });
    this._state = "idle";
    this._generation = 0;
    this._muted = false;
    this._desiredMuted = false;
    this._started = false;
    this._liveSessionId = null;
    this._waiters = new Map();
    this._delegations = new Map();
    this._seenEvents = new Set();
    this._context = null;
    this._lastContext = null;
    this._usage = null;
    this._ending = null;
    this._retryCount = 0;
    this.transcript = new LiveTranscript({
      sessionId: this.sessionId,
      storage: options.storage,
      batchMs: options.batchMs ?? 500,
      callbacks: this.callbacks,
      persist: (liveId, events) => this.api.persistLiveEvents(this.sessionId, liveId, events),
      onResult: (result) => this._applyResult(result),
      onSaved: () => this._retryDelegations(),
      onError: (error, phase) => this._report(error, phase),
      shouldRetry: () => this._state !== "closed",
    });
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

  _applyResult(result) {
    if (result?.snapshot) this.callbacks.onSnapshot?.(result.snapshot);
    this.callbacks.onToolResult?.({ result });
    this.transcript.reconcile(result);
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
    this.transcript.stopRetries();
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
    void this.flushEvents().catch((error) => this._report(error, "transcript_save"));
    this._setState(state);
  }

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

  flushEvents() { return this.transcript.flush(); }

  _receiveEvent(message, generation = this._generation) {
    if (generation !== this._generation) return;
    let event;
    try { event = typeof message.data === "string" ? JSON.parse(message.data) : message.data; }
    catch (error) { this._report(error, "event_parse"); return; }
    if (!event?.type) return;
    this.callbacks.onEvent?.(event);
    if (event.type === "session.started") {
      if (!event.session?.id || !this._liveSessionId || event.session.id === this._liveSessionId) this._started = true;
      return;
    }
    this._acknowledge(event);
    if (event.type === "error") { this._report(event, "live_command"); return; }
    if (["session.usage.updated", "session.closed"].includes(event.type) && event.usage) {
      this._usage = event.usage;
      this.callbacks.onUsage?.(event.usage);
    }
    if (event.event_id && this._seenEvents.has(event.event_id)) return;
    if (event.event_id) this._seenEvents.add(event.event_id);
    const handler = EVENT_HANDLERS.get(event.type);
    if (handler) this[handler](event, generation);
  }

  _acknowledge(event) {
    const clientId = event.client_event_id ?? event.error?.client_event_id;
    const waiter = this._waiters.get(clientId)
      ?? (event.type === "session.closed" ? [...this._waiters.values()].find((candidate) => candidate.acknowledgment === "session.closed") : null);
    if (!waiter || (event.type !== waiter.acknowledgment && event.type !== "error")) return;
    clearTimeout(waiter.timer);
    for (const [key, value] of this._waiters) if (value === waiter) this._waiters.delete(key);
    if (event.type === "error") waiter.reject(errorFrom(event)); else waiter.resolve(event);
  }

  _receiveTranscript(event) {
    if (!event.event_id || typeof event.delta !== "string" || !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms)) {
      this._report(new Error("The voice service returned a transcript fragment without its original identity or timing"), "transcript_format");
      return;
    }
    this.transcript.append(event, this._liveSessionId);
  }

  _receiveDelegation(event, generation) {
    const delegation = event.delegation;
    if (delegation?.target !== "client" || !delegation.id || this._delegations.has(delegation.id)) return;
    this._delegations.set(delegation.id, { event, generation, state: "pending" });
    void this._runDelegation(delegation.id);
  }

  _receiveClosed(event) {
    this.transcript.queue(event, this._liveSessionId);
    if (this._state === "ending") return;
    this._cleanupTransport();
    this._setState("closed", { finalized: true, reason: event.reason });
    void this.flushEvents().catch((error) => this._report(error, "transcript_save"));
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
