import { errorPayload } from "./http.mjs";

/** Queue SSE chunks per response when Node signals stream backpressure. */
export function createSseEventWriter() {
  const responses = new Map();

  const detach = (response, state) => {
    response.removeListener?.("drain", state.onDrain);
    response.removeListener?.("close", state.onClose);
    response.removeListener?.("error", state.onClose);
  };

  const cleanup = (response) => {
    const state = responses.get(response);
    if (!state) return;
    state.queue.length = 0;
    detach(response, state);
    responses.delete(response);
  };

  const flush = (response, state) => {
    if (response.destroyed || response.writableEnded) {
      cleanup(response);
      return false;
    }
    if (state.draining) return false;
    while (state.queue.length) {
      const chunk = state.queue.shift();
      if (!response.write(chunk)) {
        state.draining = true;
        response.once?.("drain", state.onDrain);
        return false;
      }
    }
    cleanup(response);
    return true;
  };

  const write = (response, chunk) => {
    if (response.destroyed || response.writableEnded) {
      cleanup(response);
      return false;
    }
    let state = responses.get(response);
    if (!state) {
      state = {
        queue: [],
        draining: false,
        onDrain: null,
        onClose: null,
      };
      state.onDrain = () => {
        state.draining = false;
        flush(response, state);
      };
      state.onClose = () => cleanup(response);
      responses.set(response, state);
      response.once?.("close", state.onClose);
      response.once?.("error", state.onClose);
    }
    state.queue.push(chunk);
    return flush(response, state);
  };

  return { write, cleanup };
}

export function createSessionEvents({ store, snapshotFor }) {
  const eventClients = new Map();
  const writer = createSseEventWriter();
  const publish = (session, event = "snapshot", detail = {}, publishedSnapshot = null) => {
    const listeners = eventClients.get(session.id);
    if (!listeners?.size) return;
    const payload = JSON.stringify({
      type: event,
      snapshot: publishedSnapshot ?? snapshotFor(session),
      ...detail,
    });
    listeners.forEach((response) => {
      if (response.destroyed || response.writableEnded) {
        writer.cleanup(response);
        listeners.delete(response);
        return;
      }
      writer.write(response, `event: ${event}\ndata: ${payload}\n\n`);
    });
    if (!listeners.size) eventClients.delete(session.id);
  };

  const attach = async (req, res) => {
    let sessionId = null;
    let heartbeat = null;
    const cleanup = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      writer.cleanup(res);
      if (!sessionId) return;
      const listeners = eventClients.get(sessionId);
      listeners?.delete(res);
      if (!listeners?.size) eventClients.delete(sessionId);
    };
    req.once("close", cleanup);
    try {
      const session = await store.get(req.params.id);
      sessionId = session.id;
      if (req.destroyed) {
        cleanup();
        return;
      }
      res.status(200);
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      const listeners = eventClients.get(session.id) ?? new Set();
      listeners.add(res);
      eventClients.set(session.id, listeners);
      writer.write(res, `event: connected\ndata: ${JSON.stringify({ type: "connected", revision: session.revision })}\n\n`);
      writer.write(res, `event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", snapshot: snapshotFor(session) })}\n\n`);
      heartbeat = setInterval(() => {
        if (res.destroyed || res.writableEnded) cleanup();
        else writer.write(res, ": keep-alive\n\n");
      }, 20_000);
    } catch (error) {
      cleanup();
      if (!res.headersSent) res.status(error?.status ?? 500).json(errorPayload(error));
    }
  };

  const close = (sessionId) => {
    eventClients.get(sessionId)?.forEach((response) => {
      writer.cleanup(response);
      response.end();
    });
    eventClients.delete(sessionId);
  };
  return { publish, attach, close, dispose: () => [...eventClients.keys()].forEach(close) };
}
