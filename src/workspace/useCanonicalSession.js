import { createMapControllerActivityDelay, mapControllerPresentation } from "../session/presentation.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SessionApiError, applySessionOperation, createSession, getSession, listSessions,
  retrySessionMapController, shouldApplySessionSnapshot, subscribeSessionEvents, synthesizeSession,
} from "../sessionApi.js";
import { updateWorkspacePreferences } from "../workspaceApi.js";
import { recentMapChange } from "../workspaceUi.js";

let bootstrapPromise;

export function snapshotFrom(value) {
  return value?.snapshot ?? value?.session ?? (value?.id && value?.schema_version ? value : null);
}

function listPayload(value) {
  if (Array.isArray(value)) return { sessions: value, activeSessionId: value[0]?.id ?? null };
  return {
    sessions: value?.sessions ?? [],
    activeSessionId: value?.active_session_id ?? value?.activeSessionId ?? null,
  };
}

async function bootstrapCanonicalSession() {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const listed = listPayload(await listSessions());
      const targetId = listed.activeSessionId ?? listed.sessions[0]?.id;
      if (targetId) return { listed, snapshot: snapshotFrom(await getSession(targetId)) };
      const created = await createSession({});
      const snapshot = snapshotFrom(created);
      return {
        listed: listPayload(await listSessions()),
        snapshot,
      };
    })().catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}

function summaryFromSession(session) {
  return {
    id: session.id,
    title: session.title,
    updated_at: session.updated_at,
    thought_count: session.nodes?.length ?? 0,
    revision: session.revision,
  };
}

// Server-owned session state and revision-aware writes have one entry point.
export function useCanonicalSession({ onSnapshot, showToast }) {
  const [canonical, setCanonical] = useState(null);
  const canonicalRef = useRef(null);
  const sessionIdRef = useRef(null);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pendingWrites, setPendingWrites] = useState(0);
  const [syncConnected, setSyncConnected] = useState(true);
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [controllerRetrying, setControllerRetrying] = useState(false);
  const [synthesis, setSynthesis] = useState("");
  const [synthesizing, setSynthesizing] = useState(false);
  const [recentChange, setRecentChange] = useState(null);

  const [controllerActivity, setControllerActivity] = useState({
    sessionId: null,
    active: false,
    visible: false,
  });
  const controllerActivityDelayRef = useRef(null);
  useEffect(() => {
    const delay = createMapControllerActivityDelay({ onChange: setControllerActivity });
    controllerActivityDelayRef.current = delay;
    return () => {
      delay.dispose();
      if (controllerActivityDelayRef.current === delay) controllerActivityDelayRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerActivityDelayRef.current?.update(canonical);
  }, [canonical?.id, canonical?.map_controller?.status]);

  const controllerStatus = mapControllerPresentation(canonical?.map_controller, {
    activeVisible: controllerActivity.sessionId === canonical?.id
      && controllerActivity.active
      && controllerActivity.visible,
  });
  const applyCanonicalSnapshot = useCallback((
    snapshot,
    { animateNew = true, allowSessionSwitch = false } = {},
  ) => {
    if (!snapshot?.id) return;
    if (
      sessionIdRef.current
      && snapshot.id !== sessionIdRef.current
      && !allowSessionSwitch
    ) return;
    const currentSnapshot = canonicalRef.current;
    if (!shouldApplySessionSnapshot(currentSnapshot, snapshot)) return;
    const switching = currentSnapshot?.id !== snapshot.id;
    const changed = recentMapChange(currentSnapshot, snapshot);
    if (switching) setRecentChange(null);
    else if (animateNew && changed) setRecentChange(changed);
    canonicalRef.current = snapshot;
    sessionIdRef.current = snapshot.id;
    onSnapshot(snapshot, { animateNew, switching });
    setCanonical(snapshot);
    setSynthesis(snapshot.synthesis?.text ?? "");
    setSessions((current) => {
      const next = current.filter((item) => item.id !== snapshot.id);
      return [summaryFromSession(snapshot), ...next];
    });
  }, [onSnapshot]);

  const refreshSessions = useCallback(async () => {
    const payload = listPayload(await listSessions());
    setSessions(payload.sessions);
    return payload;
  }, []);

  const loadSession = useCallback(async (id) => {
    if (!id) return;
    setLoading(true);
    setSynthesizing(false);
    try {
      const snapshot = snapshotFrom(await getSession(id));
      applyCanonicalSnapshot(snapshot, { animateNew: false, allowSessionSwitch: true });
      await refreshSessions();
    } catch (error) {
      showToast(error.message);
    } finally {
      setLoading(false);
    }
  }, [applyCanonicalSnapshot, refreshSessions, showToast]);

  useEffect(() => {
    let cancelled = false;
    bootstrapCanonicalSession()
      .then(({ listed, snapshot }) => {
        if (cancelled) return;
        setSessions(listed.sessions);
        applyCanonicalSnapshot(snapshot, { animateNew: false });
        setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoading(false);
        showToast(error.message);
      });
    return () => { cancelled = true; };
  }, [applyCanonicalSnapshot, showToast]);

  useEffect(() => {
    if (!canonical?.id) return undefined;
    return subscribeSessionEvents(canonical.id, {
      onSnapshot: applyCanonicalSnapshot,
      onError: () => setSyncConnected(false),
      onOpen: () => setSyncConnected(true),
    });
  }, [canonical?.id, applyCanonicalSnapshot]);

  const perform = useCallback(async (operation, { actor = "you", callId } = {}) => {
    const id = sessionIdRef.current;
    if (!id || !canonicalRef.current) throw new Error("No map session is open");
    setPendingWrites((value) => value + 1);
    try {
      const result = await applySessionOperation(id, operation, {
        expectedRevision: canonicalRef.current.revision,
        callId,
        actor,
      });
      const snapshot = snapshotFrom(result);
      if (snapshot) applyCanonicalSnapshot(snapshot);
      if (result?.warnings?.length) showToast(result.warnings.join(" · "));
      return result;
    } catch (error) {
      if (error instanceof SessionApiError && error.snapshot) applyCanonicalSnapshot(error.snapshot);
      throw error;
    } finally {
      setPendingWrites((value) => Math.max(0, value - 1));
    }
  }, [applyCanonicalSnapshot, showToast]);

  // UI commands report failures once. perform stays throwing for transactional callers.
  const runCommand = useCallback(async (execute, onSuccess) => {
    try {
      const result = await execute();
      onSuccess?.(result);
      return result;
    } catch (error) { showToast(error.message); }
  }, [showToast]);
  const command = useCallback((operation, onSuccess) => (
    runCommand(() => perform(operation), onSuccess)
  ), [runCommand, perform]);

  const setPreferences = async (patch) => {
    if (!canonical?.id || preferenceBusy) return;
    setPreferenceBusy(true);
    try {
      const result = await updateWorkspacePreferences(canonical.id, patch);
      const snapshot = snapshotFrom(result);
      if (snapshot) applyCanonicalSnapshot(snapshot);
    } catch (error) { showToast(error.message); }
    finally { setPreferenceBusy(false); }
  };

  const retryMapController = async () => {
    if (!canonical?.id || controllerRetrying) return;
    setControllerRetrying(true);
    try {
      const result = await retrySessionMapController(canonical.id);
      const snapshot = snapshotFrom(result);
      if (snapshot) applyCanonicalSnapshot(snapshot);
    } catch (error) {
      if (error instanceof SessionApiError && error.snapshot) applyCanonicalSnapshot(error.snapshot);
      showToast(error.message);
    } finally {
      setControllerRetrying(false);
    }
  };

  const requestSynthesis = async () => {
    if (!canonical?.nodes?.length) return;
    const requestedSessionId = canonical.id;
    setSynthesizing(true);
    try {
      const result = await synthesizeSession(requestedSessionId, { expectedRevision: canonical.revision });
      if (sessionIdRef.current !== requestedSessionId) return;
      const snapshot = snapshotFrom(result);
      if (snapshot) applyCanonicalSnapshot(snapshot);
      setSynthesis(result?.synthesis?.text ?? result?.synthesis ?? snapshot?.synthesis?.text ?? "No synthesis was returned.");
    } catch (error) {
      if (sessionIdRef.current === requestedSessionId) showToast(error.message);
    } finally {
      if (sessionIdRef.current === requestedSessionId) setSynthesizing(false);
    }
  };

  useEffect(() => {
    if (!recentChange) return undefined;
    const timer = window.setTimeout(() => setRecentChange(null), 12000);
    return () => window.clearTimeout(timer);
  }, [recentChange]);

  return {
    canonical, canonicalRef, sessionIdRef, sessions, loading, pendingWrites, syncConnected,
    recentChange, setRecentChange, synthesis, synthesizing, requestSynthesis,
    preferenceBusy, setPreferences, controllerRetrying, retryMapController, controllerStatus,
    applyCanonicalSnapshot, refreshSessions, loadSession, perform, runCommand, command,
  };
}
