export const preferencesAllowCurator = (snapshot) => (
  snapshot?.preferences?.partner_mode !== "quiet" && !snapshot?.preferences?.mapping_paused
);

export const completedUserTurns = (snapshot) => (
  (snapshot.transcript ?? []).filter((utterance) => utterance?.speaker === "you" && utterance?.text?.trim())
);

function snapshotFingerprint(snapshot) {
  const latest = snapshot.transcript?.findLast((utterance) => utterance?.speaker === "you");
  return `${snapshot.revision}:${snapshot.transcript?.length ?? 0}:${latest?.id ?? "none"}`;
}

/** Run proposal-only work after the map controller settles, with a per-session attention budget. */
export function createCuratorScheduler({
  curator,
  loadSnapshot,
  onProposal,
  isBlocked = () => false,
  onError = (error) => console.error(error),
  idleMs = 10_000,
  minimumUserTurnsBetweenRuns = 3,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!curator || typeof loadSnapshot !== "function" || typeof onProposal !== "function") {
    throw new TypeError("Curator scheduler requires curator, loadSnapshot, and onProposal");
  }
  const sessions = new Map();
  let disposed = false;
  const entryFor = (sessionId) => {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { timer: null, generation: 0, active: false, queued: false });
    }
    return sessions.get(sessionId);
  };
  const eligible = (snapshot) => preferencesAllowCurator(snapshot) && curator.shouldRun(snapshot);

  const cancel = (sessionId) => {
    const entry = entryFor(sessionId);
    entry.generation += 1;
    if (entry.timer !== null) clearTimer(entry.timer);
    entry.timer = null;
    entry.queued = false;
  };

  const schedule = (sessionId) => {
    if (disposed) return false;
    cancel(sessionId);
    const entry = entryFor(sessionId);
    const generation = entry.generation;
    const isCurrent = () => !disposed && generation === entry.generation;
    entry.timer = setTimer(async () => {
      if (!isCurrent()) return;
      entry.timer = null;
      let ownsRun = false;
      try {
        const blocked = await isBlocked(sessionId);
        if (!isCurrent()) return;
        if (blocked) {
          schedule(sessionId);
          return;
        }
        if (entry.active) {
          entry.queued = true;
          return;
        }
        ownsRun = true;
        entry.active = true;
        const snapshot = await loadSnapshot(sessionId);
        if (!isCurrent()) return;
        const fingerprint = snapshotFingerprint(snapshot);
        const turns = completedUserTurns(snapshot).length;
        if (!eligible(snapshot) || entry.fingerprint === fingerprint
          || (entry.userTurns !== undefined && turns - entry.userTurns < minimumUserTurnsBetweenRuns)) return;
        const proposal = await curator.propose(snapshot);
        if (!isCurrent()) return;
        entry.fingerprint = fingerprint;
        entry.userTurns = turns;
        if (!proposal) return;
        const latest = await loadSnapshot(sessionId);
        if (!isCurrent() || !eligible(latest)) return;
        const controllerBusy = await isBlocked(sessionId);
        if (!isCurrent()) return;
        if (controllerBusy || snapshotFingerprint(latest) !== fingerprint) {
          // Discard stale work, but count this evaluation toward the turn budget.
          entry.queued = true;
          return;
        }
        await onProposal(sessionId, proposal);
      } catch (error) {
        onError(error, sessionId);
      } finally {
        if (ownsRun) {
          entry.active = false;
          if (entry.queued) schedule(sessionId);
        }
      }
    }, idleMs);
    return true;
  };

  return {
    notify(sessionId) {
      if (disposed || !curator.enabled) return false;
      const entry = entryFor(sessionId);
      if (!entry.active) return schedule(sessionId);
      entry.queued = true;
      return true;
    },
    cancel,
    dispose() {
      disposed = true;
      for (const sessionId of sessions.keys()) cancel(sessionId);
    },
  };
}
