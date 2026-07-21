function isTransient(error) {
  const status = Number(error?.status ?? error?.statusCode);
  return error?.retryable === true
    || status === 408
    || status === 409
    || status === 429
    || status >= 500
    || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "APIConnectionError", "RateLimitError"].includes(error?.code ?? error?.name);
}

/** Per-session sliding debounce and single-flight scheduler. */
export function createMapControllerScheduler({
  controller,
  loadSnapshot,
  idleMs = 1_500,
  retryDelays = [1_000, 4_000, 15_000],
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = () => {},
  onStateChange = () => {},
  onComplete = () => {},
} = {}) {
  if (!controller || typeof controller.run !== "function" || typeof loadSnapshot !== "function") {
    throw new TypeError("Map controller scheduler requires controller and loadSnapshot.");
  }
  const sessions = new Map();
  let disposed = false;

  const entryFor = (sessionId) => {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        timer: null,
        timerToken: null,
        preparing: false,
        active: false,
        queued: false,
        retryAttempt: 0,
        pendingWatermark: null,
        abortController: null,
        generation: 0,
      });
    }
    return sessions.get(sessionId);
  };

  const clearScheduled = (entry) => {
    if (entry.timer !== null) clearTimer(entry.timer);
    entry.timer = null;
    entry.timerToken = null;
  };

  const hasPendingUser = (snapshot, watermark = snapshot.transcript?.length ?? 0) => (
    (snapshot.transcript ?? [])
      .slice(snapshot.map_controller?.processed_transcript_count ?? 0, watermark)
      .some((item) => item?.speaker === "you" && item?.text?.trim())
  );

  let schedule;

  const scheduleQueuedPass = (sessionId, entry) => {
    if (entry.queued && entry.timer === null && !entry.active && !entry.preparing && !disposed) {
      entry.queued = false;
      schedule(sessionId, idleMs);
    }
  };

  const handleFailure = async (sessionId, entry, generation, error) => {
    if (generation !== entry.generation || disposed) return;
    if (isTransient(error) && entry.retryAttempt < retryDelays.length) {
      const delay = retryDelays[entry.retryAttempt];
      entry.retryAttempt += 1;
      schedule(sessionId, delay);
      return;
    }
    entry.retryAttempt = 0;
    entry.pendingWatermark = null;
    try {
      await controller.recordFailure?.(sessionId, error);
    } catch (recordError) {
      onError(recordError, sessionId);
    }
    onError(error, sessionId);
  };

  const start = async (sessionId, generation, timerToken) => {
    const entry = entryFor(sessionId);
    if (disposed
      || generation !== entry.generation
      || entry.timerToken !== timerToken
      || entry.preparing
      || entry.active) return;
    entry.timer = null;
    entry.timerToken = null;
    entry.preparing = true;
    reportState(sessionId);
    let snapshot;
    try {
      snapshot = await loadSnapshot(sessionId);
    } catch (error) {
      if (generation !== entry.generation || disposed) return;
      entry.preparing = false;
      await handleFailure(sessionId, entry, generation, error);
      scheduleQueuedPass(sessionId, entry);
      return;
    }
    if (disposed || generation !== entry.generation || !entry.preparing || entry.active) return;
    entry.preparing = false;
    if (entry.pendingWatermark === null) entry.pendingWatermark = snapshot.transcript?.length ?? 0;
    if (!hasPendingUser(snapshot, entry.pendingWatermark)) {
      entry.pendingWatermark = null;
      entry.retryAttempt = 0;
      entry.queued = false;
      return;
    }
    entry.active = true;
    entry.abortController = new AbortController();
    reportState(sessionId);
    let completed = null;
    try {
      completed = await controller.run(sessionId, {
        watermark: entry.pendingWatermark,
        signal: entry.abortController.signal,
      });
      entry.retryAttempt = 0;
      entry.pendingWatermark = null;
    } catch (error) {
      if (entry.abortController.signal.aborted || generation !== entry.generation || disposed) return;
      await handleFailure(sessionId, entry, generation, error);
    } finally {
      entry.active = false;
      entry.abortController = null;
      if (completed) {
        try {
          await onComplete(sessionId, completed);
        } catch (error) {
          onError(error, sessionId);
        }
      }
      reportState(sessionId);
      scheduleQueuedPass(sessionId, entry);
    }
  };

  schedule = (sessionId, delay) => {
    const entry = entryFor(sessionId);
    clearScheduled(entry);
    const generation = entry.generation;
    const timerToken = {};
    entry.timerToken = timerToken;
    entry.timer = setTimer(() => start(sessionId, generation, timerToken), delay);
    reportState(sessionId);
    return true;
  };

  const notify = (sessionId, completedUtterance) => {
    if (disposed || completedUtterance?.speaker !== "you" || !completedUtterance?.text?.trim()) return false;
    const entry = entryFor(sessionId);
    if (entry.preparing || entry.active) {
      entry.queued = true;
      reportState(sessionId);
      return true;
    }
    if (entry.timer !== null && entry.retryAttempt > 0) {
      entry.queued = true;
      reportState(sessionId);
      return true;
    }
    entry.retryAttempt = 0;
    entry.pendingWatermark = null;
    return schedule(sessionId, idleMs);
  };

  const retry = (sessionId) => {
    if (disposed) return false;
    const entry = entryFor(sessionId);
    entry.retryAttempt = 0;
    entry.pendingWatermark = null;
    if (entry.active) {
      entry.queued = true;
      reportState(sessionId);
    } else schedule(sessionId, 0);
    return true;
  };

  const recover = (sessionId) => {
    if (disposed) return false;
    const entry = entryFor(sessionId);
    if (entry.preparing || entry.active) {
      entry.queued = true;
      reportState(sessionId);
      return true;
    }
    if (entry.timer !== null) return true;
    entry.retryAttempt = 0;
    entry.pendingWatermark = null;
    return schedule(sessionId, 0);
  };

  const cancel = (sessionId) => {
    const entry = sessions.get(sessionId);
    if (!entry) return false;
    entry.generation += 1;
    clearScheduled(entry);
    entry.preparing = false;
    entry.queued = false;
    entry.retryAttempt = 0;
    entry.pendingWatermark = null;
    entry.abortController?.abort(new Error("Map controller run cancelled."));
    return true;
  };

  const state = (sessionId) => {
    const entry = sessions.get(sessionId);
    return {
      scheduled: Boolean(entry?.timer !== null && entry?.timer !== undefined),
      preparing: Boolean(entry?.preparing),
      active: Boolean(entry?.active),
      queued: Boolean(entry?.queued),
      retry_attempt: entry?.retryAttempt ?? 0,
      watermark: entry?.pendingWatermark ?? null,
    };
  };

  const reportState = (sessionId) => {
    try {
      onStateChange(sessionId, state(sessionId));
    } catch (error) {
      onError(error, sessionId);
    }
  };

  const dispose = () => {
    disposed = true;
    [...sessions.keys()].forEach(cancel);
  };

  return {
    notify,
    retry,
    recover,
    openSession: recover,
    cancel,
    state,
    dispose,
  };
}
