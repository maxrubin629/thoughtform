import {
  executeSessionToolCall,
  negotiateRealtimeSession,
  SessionApiError,
} from "./sessionApi.js";

const DEFAULT_AUDIO_CONSTRAINTS = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const CALLBACK_NAMES = [
  "onStateChange",
  "onStatus",
  "onEvent",
  "onError",
  "onUserTranscriptPartial",
  "onUserTranscriptFinal",
  "onInputTranscriptDone",
  "onPartnerTranscriptPartial",
  "onPartnerTranscriptFinal",
  "onToolCall",
  "onToolResult",
  "onLocalTextItem",
];

function clientItemId() {
  const value = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `item_${value.replaceAll("-", "")}`;
}

function asError(value, fallback = "Realtime session error") {
  if (value instanceof Error) return value;
  const message = value?.message ?? value?.error?.message ?? value?.error ?? fallback;
  const error = new Error(message);
  error.code = value?.code ?? value?.error?.code;
  error.details = value;
  return error;
}

function parseToolArguments(value) {
  if (value == null || value === "") return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new SessionApiError("Realtime returned invalid function arguments", {
      code: "invalid_tool_arguments",
      details: { arguments: value },
      cause,
    });
  }
}

function pendingTranscriptError(value) {
  const payload = value instanceof SessionApiError ? value.details : value;
  const error = payload?.error ?? payload?.details?.error;
  if (error?.code !== "transcript_pending" || error?.retryable !== true) return null;
  return {
    payload,
    itemId: error.realtime_item_id
      ?? error.item_id
      ?? payload?.realtime_item_id
      ?? payload?.item_id
      ?? null,
  };
}

function referencedTranscriptItem(toolArguments, fallback = null) {
  if (!toolArguments || typeof toolArguments !== "object") return fallback;
  return toolArguments.realtime_item_id
    ?? toolArguments.input_item_id
    ?? toolArguments.utterance_item_id
    ?? toolArguments.source_item_id
    ?? fallback;
}

function functionOutputFor(callId, result) {
  const wrapped = result?.function_call_output;
  const supplied = wrapped?.type === "conversation.item.create"
    ? wrapped.item
    : wrapped ?? result?.item;
  if (supplied && (supplied.type === "function_call_output" || "output" in supplied)) {
    return {
      ...supplied,
      call_id: supplied.call_id ?? callId,
      output: typeof supplied.output === "string"
        ? supplied.output
        : JSON.stringify(supplied.output ?? result),
    };
  }

  return {
    type: "function_call_output",
    call_id: callId,
    output: JSON.stringify(result ?? { ok: true }),
  };
}

function waitForChannelOpen(channel, timeoutMs = 15_000) {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      channel.removeEventListener?.("open", handleOpen);
      channel.removeEventListener?.("close", handleClose);
      channel.removeEventListener?.("error", handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleClose = () => {
      cleanup();
      reject(new Error("Realtime data channel closed during setup"));
    };
    const handleError = (event) => {
      cleanup();
      reject(asError(event, "Realtime data channel failed during setup"));
    };

    channel.addEventListener?.("open", handleOpen);
    channel.addEventListener?.("close", handleClose);
    channel.addEventListener?.("error", handleError);
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Realtime data channel did not open in time"));
    }, timeoutMs);
  });
}

/**
 * Browser-side bridge for one canonical Thoughtform session.
 *
 * No microphone permission is requested until connect() is explicitly called.
 * The standard OpenAI credential is never read by, stored in, or sent through
 * this class; SDP negotiation always goes through the same-origin server route.
 */
export class SessionRealtimeClient {
  constructor(options = {}) {
    if (!options.sessionId) throw new TypeError("A session ID is required");

    this.sessionId = options.sessionId;
    this.voiceMode = options.voiceMode ?? "vad";
    this.getExpectedRevision = options.getExpectedRevision;
    this.audioElement = options.audioElement ?? null;
    this.peerConnectionFactory = options.peerConnectionFactory
      ?? (typeof globalThis.RTCPeerConnection === "function"
        ? () => new globalThis.RTCPeerConnection()
        : null);
    this.mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
    this.channelOpenTimeoutMs = options.channelOpenTimeoutMs ?? 15_000;

    this.callbacks = { ...(options.callbacks ?? {}) };
    for (const name of CALLBACK_NAMES) {
      if (typeof options[name] === "function") this.callbacks[name] = options[name];
    }

    this._state = "idle";
    this._peer = null;
    this._channel = null;
    this._localStream = null;
    this._abortController = null;
    this._connectionGeneration = 0;
    this._lastConnectOptions = null;
    this._latestInputItemId = null;
    this._inputTranscripts = new Map();
    this._partnerTranscripts = new Map();
    this._handledCallIds = new Set();
    this._inflightCallIds = new Set();
    this._pendingTranscriptCalls = new Map();
    this._committedTranscriptItems = new Set();
    this._toolQueue = Promise.resolve();
    this._queuedToolCalls = 0;
    this._toolOutputAwaitingResponse = false;
  }

  get connectionState() {
    return this._state;
  }

  get connected() {
    return this._state === "connected" && this._channel?.readyState === "open";
  }

  _setState(state, detail = null) {
    if (this._state === state && detail == null) return;
    this._state = state;
    const update = { state, detail, connected: state === "connected" };
    this.callbacks.onStateChange?.(update);
    this.callbacks.onStatus?.(state, detail);
  }

  _reportError(error, context = null) {
    const normalized = asError(error);
    this.callbacks.onError?.(normalized, context);
    return normalized;
  }

  _makeAudioElement() {
    if (this.audioElement) return this.audioElement;
    if (typeof globalThis.Audio === "function") {
      this.audioElement = new globalThis.Audio();
    } else if (globalThis.document?.createElement) {
      this.audioElement = globalThis.document.createElement("audio");
    }
    if (this.audioElement) {
      this.audioElement.autoplay = true;
      this.audioElement.playsInline = true;
    }
    return this.audioElement;
  }

  async connect(options = {}) {
    if (this._state === "requesting_microphone" || this._state === "connecting") {
      throw new Error("A Realtime connection is already being created");
    }
    if (this.connected) return this;

    const voiceMode = options.voiceMode ?? this.voiceMode ?? "vad";
    if (voiceMode !== "vad" && voiceMode !== "push-to-talk") {
      throw new TypeError('voiceMode must be either "vad" or "push-to-talk"');
    }
    if (!this.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is not available in this browser");
    }
    if (!this.peerConnectionFactory) {
      throw new Error("WebRTC is not available in this browser");
    }

    this.disconnect({ state: "idle" });
    const generation = ++this._connectionGeneration;
    this._abortController = new AbortController();
    this.voiceMode = voiceMode;
    this._lastConnectOptions = { ...options, voiceMode };

    try {
      this._setState("requesting_microphone");
      const stream = await this.mediaDevices.getUserMedia({
        audio: options.audioConstraints ?? DEFAULT_AUDIO_CONSTRAINTS,
      });
      if (generation !== this._connectionGeneration) {
        for (const track of stream.getTracks()) track.stop();
        throw new DOMException("Realtime setup was cancelled", "AbortError");
      }
      this._localStream = stream;

      const peer = this.peerConnectionFactory();
      if (!peer) throw new Error("Could not create a WebRTC connection");
      this._peer = peer;
      this._setState("connecting");

      const audio = this._makeAudioElement();
      peer.ontrack = (event) => {
        if (!audio) return;
        const streamForTrack = event.streams?.[0]
          ?? (typeof globalThis.MediaStream === "function" ? new globalThis.MediaStream([event.track]) : null);
        if (streamForTrack) audio.srcObject = streamForTrack;
        audio.play?.().catch((error) => this._reportError(error, { phase: "audio_playback" }));
      };
      peer.onconnectionstatechange = () => {
        if (generation !== this._connectionGeneration) return;
        if (peer.connectionState === "failed") {
          this.disconnect({ state: "failed" });
        } else if (peer.connectionState === "disconnected" && this._state === "connected") {
          this.disconnect({ state: "disconnected" });
        }
      };

      for (const track of stream.getAudioTracks()) {
        track.enabled = voiceMode !== "push-to-talk";
        peer.addTrack(track, stream);
      }

      const channel = peer.createDataChannel("oai-events");
      this._channel = channel;
      channel.addEventListener?.("message", (event) => this._receiveEvent(event, { generation }));
      channel.addEventListener?.("error", (event) => {
        this._reportError(event, { phase: "data_channel" });
        if (generation === this._connectionGeneration) this.disconnect({ state: "failed" });
      });
      channel.addEventListener?.("close", () => {
        if (generation === this._connectionGeneration && this._state === "connected") {
          this.disconnect({ state: "disconnected" });
        }
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const answerSdp = await negotiateRealtimeSession(this.sessionId, offer.sdp, {
        voiceMode,
        signal: this._abortController.signal,
      });
      if (generation !== this._connectionGeneration) {
        throw new DOMException("Realtime setup was cancelled", "AbortError");
      }
      await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
      await waitForChannelOpen(channel, this.channelOpenTimeoutMs);

      this._setState("connected", { voiceMode });
      return this;
    } catch (error) {
      const cancelled = error?.name === "AbortError";
      this.disconnect({ state: cancelled ? "idle" : "failed" });
      if (!cancelled) this._reportError(error, { phase: "connect" });
      throw error;
    }
  }

  async reconnect(options = this._lastConnectOptions ?? {}) {
    this.disconnect({ state: "idle" });
    return this.connect(options);
  }

  disconnect({ state = "closed" } = {}) {
    this._connectionGeneration += 1;
    this._abortController?.abort();
    this._abortController = null;

    if (this._channel) {
      try {
        this._channel.close();
      } catch {
        // Closing an already-closed RTCDataChannel is harmless.
      }
      this._channel = null;
    }

    if (this._peer) {
      this._peer.ontrack = null;
      this._peer.onconnectionstatechange = null;
      try {
        this._peer.close();
      } catch {
        // Closing an already-closed peer is harmless.
      }
      this._peer = null;
    }

    if (this._localStream) {
      for (const track of this._localStream.getTracks()) track.stop();
      this._localStream = null;
    }

    if (this.audioElement?.srcObject) this.audioElement.srcObject = null;
    this._inflightCallIds.clear();
    this._inputTranscripts.clear();
    this._partnerTranscripts.clear();
    this._pendingTranscriptCalls.clear();
    this._committedTranscriptItems.clear();
    this._latestInputItemId = null;
    this._toolQueue = Promise.resolve();
    this._queuedToolCalls = 0;
    this._toolOutputAwaitingResponse = false;
    this._setState(state);
  }

  close() {
    this.disconnect({ state: "closed" });
  }

  _send(event) {
    if (!this._channel || this._channel.readyState !== "open") {
      throw new Error("Realtime is not connected");
    }
    this._channel.send(JSON.stringify(event));
  }

  requestResponse(response = {}) {
    this._send({
      type: "response.create",
      ...(Object.keys(response).length ? { response } : {}),
    });
  }

  async sendText(text, { beforeResponse, response } = {}) {
    const normalized = text?.trim();
    if (!normalized) throw new TypeError("Text is required");

    const itemId = clientItemId();
    this._send({
      type: "conversation.item.create",
      item: {
        id: itemId,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: normalized }],
      },
    });

    // The UI can commit the exact text and matching item ID to the canonical
    // transcript here before the model is asked to respond.
    const commit = beforeResponse ?? this.callbacks.onLocalTextItem;
    if (commit) await commit({ itemId, text: normalized });
    this.requestResponse(response);
    return itemId;
  }

  startPushToTalk() {
    if (this.voiceMode !== "push-to-talk") return false;
    if (!this.connected) throw new Error("Realtime is not connected");
    this._send({ type: "input_audio_buffer.clear" });
    for (const track of this._localStream?.getAudioTracks?.() ?? []) track.enabled = true;
    return true;
  }

  stopPushToTalk({ requestResponse = true } = {}) {
    if (this.voiceMode !== "push-to-talk") return false;
    if (!this.connected) throw new Error("Realtime is not connected");
    for (const track of this._localStream?.getAudioTracks?.() ?? []) track.enabled = false;
    this._send({ type: "input_audio_buffer.commit" });
    if (requestResponse) this.requestResponse();
    return true;
  }

  setMuted(muted) {
    for (const track of this._localStream?.getAudioTracks?.() ?? []) {
      track.enabled = !muted && (this.voiceMode !== "push-to-talk");
    }
  }

  async _receiveEvent(messageEvent, { generation = this._connectionGeneration } = {}) {
    if (generation !== this._connectionGeneration) return;
    let event;
    try {
      event = typeof messageEvent.data === "string"
        ? JSON.parse(messageEvent.data)
        : messageEvent.data;
    } catch (error) {
      this._reportError(error, { phase: "parse_event", raw: messageEvent.data });
      return;
    }

    try {
      this.callbacks.onEvent?.(event);
      switch (event?.type) {
        case "conversation.item.input_audio_transcription.delta":
          this._handleInputTranscriptDelta(event);
          break;
        case "conversation.item.input_audio_transcription.completed":
          await this._handleInputTranscriptCompleted(event);
          break;
        case "conversation.item.input_audio_transcription.failed":
          this._reportError(event.error ?? event, { phase: "input_transcription", event });
          break;
        case "response.output_audio_transcript.delta":
          this._handlePartnerTranscriptDelta(event);
          break;
        case "response.output_audio_transcript.done":
          this._handlePartnerTranscriptDone(event);
          break;
        case "response.function_call_arguments.done":
          await this._queueToolCall(event, { generation });
          break;
        case "error":
          this._reportError(event.error ?? event, { phase: "realtime", event });
          break;
        default:
          break;
      }
    } catch (error) {
      this._reportError(error, { phase: "handle_event", event });
    }
  }

  _handleInputTranscriptDelta(event) {
    const itemId = event.item_id ?? event.itemId ?? "current";
    const previous = this._inputTranscripts.get(itemId) ?? "";
    const text = `${previous}${event.delta ?? ""}`;
    this._inputTranscripts.set(itemId, text);
    this.callbacks.onUserTranscriptPartial?.({
      text,
      delta: event.delta ?? "",
      itemId: itemId === "current" ? null : itemId,
      event,
    });
  }

  async _handleInputTranscriptCompleted(event) {
    const itemId = event.item_id ?? event.itemId ?? null;
    const text = event.transcript
      ?? (itemId ? this._inputTranscripts.get(itemId) : null)
      ?? this._inputTranscripts.get("current")
      ?? "";
    if (itemId) this._inputTranscripts.delete(itemId);
    this._inputTranscripts.delete("current");
    this._latestInputItemId = itemId ?? this._latestInputItemId;
    const payload = { text, itemId, event };

    const callbacks = new Set([
      this.callbacks.onUserTranscriptFinal,
      this.callbacks.onInputTranscriptDone,
    ].filter(Boolean));
    for (const callback of callbacks) {
      const acknowledgment = await callback(payload);
      if (itemId && (acknowledgment === true || acknowledgment?.committed === true)) {
        await this.notifyTranscriptCommitted(itemId);
      }
    }
  }

  _handlePartnerTranscriptDelta(event) {
    const key = event.item_id ?? event.response_id ?? "current";
    const previous = this._partnerTranscripts.get(key) ?? "";
    const text = `${previous}${event.delta ?? ""}`;
    this._partnerTranscripts.set(key, text);
    this.callbacks.onPartnerTranscriptPartial?.({
      text,
      delta: event.delta ?? "",
      itemId: event.item_id ?? null,
      responseId: event.response_id ?? null,
      event,
    });
  }

  _handlePartnerTranscriptDone(event) {
    const key = event.item_id ?? event.response_id ?? "current";
    const text = event.transcript ?? this._partnerTranscripts.get(key) ?? "";
    this._partnerTranscripts.delete(key);
    this.callbacks.onPartnerTranscriptFinal?.({
      text,
      itemId: event.item_id ?? null,
      responseId: event.response_id ?? null,
      event,
    });
  }

  async _expectedRevision() {
    if (typeof this.getExpectedRevision !== "function") return undefined;
    const value = await this.getExpectedRevision();
    return typeof value === "object" ? value?.revision : value;
  }

  async _queueToolCall(event, options = {}) {
    this._queuedToolCalls += 1;
    const task = this._toolQueue.then(() => this._handleToolCall(event, options));
    this._toolQueue = task.catch(() => {});
    let outcome;
    try {
      outcome = await task;
      if (outcome?.outputSent) this._toolOutputAwaitingResponse = true;
      return outcome;
    } finally {
      this._queuedToolCalls = Math.max(0, this._queuedToolCalls - 1);
      if (this._queuedToolCalls === 0
        && this._pendingTranscriptCalls.size === 0
        && this._toolOutputAwaitingResponse
        && this.connected) {
        this._toolOutputAwaitingResponse = false;
        this.requestResponse();
      }
    }
  }

  async _handleToolCall(event, { retryCount = 0, generation = this._connectionGeneration } = {}) {
    if (generation !== this._connectionGeneration) {
      return { outputSent: false, superseded: true };
    }
    const callId = event.call_id ?? event.callId;
    const name = event.name;
    if (!callId || !name) {
      throw new Error("Realtime function call is missing a call ID or tool name");
    }
    if (this._handledCallIds.has(callId) || this._inflightCallIds.has(callId)) {
      return { outputSent: false, duplicate: true };
    }

    let toolArguments;
    try {
      toolArguments = parseToolArguments(event.arguments);
    } catch (error) {
      this._sendToolFailure(callId, error);
      this._handledCallIds.add(callId);
      return { outputSent: true };
    }

    this._inflightCallIds.add(callId);
    const call = { callId, name, arguments: toolArguments, event };
    this.callbacks.onToolCall?.(call);

    try {
      const result = await executeSessionToolCall(this.sessionId, {
        name,
        arguments: toolArguments,
        callId,
        expectedRevision: toolArguments.expected_revision ?? await this._expectedRevision(),
      });
      if (generation !== this._connectionGeneration) {
        return { outputSent: false, superseded: true };
      }
      const pending = pendingTranscriptError(result);
      if (pending) {
        if (retryCount >= 3) {
          this._sendToolFailure(callId, pending.payload);
          this._handledCallIds.add(callId);
          return { outputSent: true };
        }
        this._bufferTranscriptCall(event, toolArguments, pending.itemId, retryCount);
        return { outputSent: false, buffered: true };
      }

      this._sendToolResult(callId, result);
      this._handledCallIds.add(callId);
      this.callbacks.onToolResult?.({ ...call, result });
      return { outputSent: true };
    } catch (error) {
      if (generation !== this._connectionGeneration) {
        return { outputSent: false, superseded: true };
      }
      const pending = pendingTranscriptError(error);
      if (pending) {
        if (retryCount >= 3) {
          this._sendToolFailure(callId, error);
          this._handledCallIds.add(callId);
          return { outputSent: true };
        }
        this._bufferTranscriptCall(event, toolArguments, pending.itemId, retryCount);
        return { outputSent: false, buffered: true };
      }

      this._reportError(error, { phase: "tool_call", call });
      this._sendToolFailure(callId, error);
      this._handledCallIds.add(callId);
      return { outputSent: true };
    } finally {
      this._inflightCallIds.delete(callId);
    }
  }

  _bufferTranscriptCall(event, toolArguments, serverItemId, retryCount) {
    const itemId = serverItemId
      ?? referencedTranscriptItem(toolArguments, this._latestInputItemId)
      ?? "*";
    const calls = this._pendingTranscriptCalls.get(itemId) ?? [];
    if (!calls.some((pending) => pending.event.call_id === event.call_id)) {
      calls.push({ event, retryCount });
      this._pendingTranscriptCalls.set(itemId, calls);
    }

    // A completed transcript acknowledgment and a tool response can cross on
    // the wire. Give the canonical commit a brief opportunity to settle.
    if (itemId !== "*" && this._committedTranscriptItems.has(itemId) && retryCount < 3) {
      setTimeout(() => {
        if (!this.connected) return;
        this.notifyTranscriptCommitted(itemId).catch((error) => {
          this._reportError(error, { phase: "retry_pending_tool", itemId });
        });
      }, 120 * (retryCount + 1));
    }
  }

  async notifyTranscriptCommitted(itemId) {
    if (!itemId) return [];
    this._committedTranscriptItems.add(itemId);
    const pending = [
      ...(this._pendingTranscriptCalls.get(itemId) ?? []),
      ...(this._pendingTranscriptCalls.get("*") ?? []),
    ];
    this._pendingTranscriptCalls.delete(itemId);
    this._pendingTranscriptCalls.delete("*");

    const retried = [];
    const retries = pending
      .filter((entry) => !this._handledCallIds.has(entry.event.call_id))
      .map((entry) => {
        retried.push(entry.event.call_id);
        return this._queueToolCall(entry.event, { retryCount: entry.retryCount + 1 });
      });
    await Promise.all(retries);
    return retried;
  }

  _sendToolResult(callId, result) {
    this._send({
      type: "conversation.item.create",
      item: functionOutputFor(callId, result),
    });
  }

  _sendToolFailure(callId, error) {
    if (error instanceof SessionApiError && error.details?.function_call_output) {
      this._sendToolResult(callId, error.details);
      return;
    }
    const result = {
      ok: false,
      error: {
        code: error?.code ?? "tool_call_failed",
        message: error?.message ?? "The requested map change could not be completed",
        retryable: error?.retryable ?? false,
      },
      ...(error?.revision == null ? {} : { revision: error.revision }),
      ...(error?.snapshot ? { snapshot: error.snapshot } : {}),
      ...(error?.details ? { details: error.details } : {}),
    };
    this._sendToolResult(callId, result);
  }
}

export const SessionRealtimeManager = SessionRealtimeClient;

export function createSessionRealtimeClient(options) {
  return new SessionRealtimeClient(options);
}
