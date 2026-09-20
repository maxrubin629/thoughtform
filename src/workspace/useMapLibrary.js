import { useState } from "react";
import { createSession, deleteSession, renameSession } from "../sessionApi.js";
import { snapshotFrom } from "./useCanonicalSession.js";

/** Local map catalog and rename draft; opening a map stays with the workspace. */
export function useMapLibrary({ session, openSession, stopRealtime }) {
  const { sessions, canonicalRef, sessionIdRef, applyCanonicalSnapshot, refreshSessions, runCommand } = session;
  const [renameId, setRenameId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const createNewMap = () => runCommand(async () => {
    const created = snapshotFrom(await createSession({}));
    await refreshSessions();
    await openSession(created.id);
  });
  const saveRename = (event) => {
    event.preventDefault();
    const title = renameValue.trim();
    if (!renameId || !title) return;
    return runCommand(async () => {
      const snapshot = snapshotFrom(await renameSession(renameId, title));
      if (snapshot?.id === canonicalRef.current?.id) applyCanonicalSnapshot(snapshot);
      await refreshSessions();
      setRenameId(null);
    });
  };
  const removeMap = (item) => {
    if (!window.confirm(`Delete “${item.title}”? This local session cannot be recovered.`)) return;
    return runCommand(async () => {
      const removingCurrent = item.id === sessionIdRef.current;
      if (removingCurrent) stopRealtime();
      await deleteSession(item.id);
      const listed = await refreshSessions();
      let nextId = listed.activeSessionId ?? listed.sessions[0]?.id;
      if (!nextId) nextId = snapshotFrom(await createSession({})).id;
      if (removingCurrent) await openSession(nextId);
    });
  };
  return { sessions, renameId, renameValue, setRenameId, setRenameValue, saveRename, createNewMap, openSession, removeMap };
}
