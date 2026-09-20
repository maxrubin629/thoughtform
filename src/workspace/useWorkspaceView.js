import { useCallback, useEffect, useRef, useState } from "react";
import { readWorkspaceState, writeWorkspaceState } from "../workspaceUi.js";

function fromSaved(saved) {
  return {
    pan: saved.pan,
    zoom: saved.zoom,
    selectedIds: saved.selected_node_ids,
    focusId: saved.focus_id,
    viewMode: saved.view_mode,
    drawerTab: saved.drawer_tab,
    drawerOpen: saved.drawer_open,
    drawerWidth: saved.drawer_width,
    showSuggestions: saved.show_suggestions,
    selectionMode: null,
  };
}

function toSaved(view) {
  return {
    pan: view.pan,
    zoom: view.zoom,
    selected_node_ids: view.selectedIds,
    focus_id: view.focusId,
    view_mode: view.viewMode,
    drawer_tab: view.drawerTab,
    drawer_open: view.drawerOpen,
    drawer_width: view.drawerWidth,
    show_suggestions: view.showSuggestions,
  };
}

/**
 * Browser view state for the explicitly restored map, independent of canonical data.
 * update accepts a patch or a function returning a patch. save flushes before switching.
 * back restores navigation fields and returns them; the caller owns graph layout work.
 */
export function useWorkspaceView() {
  const [state, setState] = useState(() => ({
    sessionId: null,
    view: fromSaved(readWorkspaceState(null)),
    history: [],
  }));
  // Event callbacks and explicit saves must see updates even before React renders them.
  const current = useRef(state);
  const commit = useCallback((next) => {
    current.current = next;
    setState(next);
  }, []);

  const update = useCallback((patch) => {
    const state = current.current;
    const changes = typeof patch === "function" ? patch(state.view) : patch;
    if (!changes || Object.keys(changes).every((key) => Object.is(changes[key], state.view[key]))) return;
    commit({ ...state, view: { ...state.view, ...changes } });
  }, [commit]);

  const restore = useCallback((snapshot) => {
    if (!snapshot?.id || snapshot.id === current.current.sessionId) return;
    const view = fromSaved(readWorkspaceState(snapshot.id));
    const ids = new Set(snapshot.nodes.map((node) => node.id));
    view.focusId = ids.has(view.focusId) ? view.focusId : null;
    view.selectedIds = view.selectedIds.filter((id) => ids.has(id));
    commit({ sessionId: snapshot.id, view, history: [] });
  }, [commit]);

  const save = useCallback(() => {
    const { sessionId, view } = current.current;
    return sessionId ? writeWorkspaceState(sessionId, toSaved(view)) : false;
  }, []);

  useEffect(() => {
    const sessionId = state.sessionId;
    if (!sessionId) return;
    // A queued save for the previous map must never receive the next map's view.
    const flush = () => { if (current.current.sessionId === sessionId) save(); };
    const timer = window.setTimeout(flush, 500);
    window.addEventListener("pagehide", flush);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
    };
  }, [state.sessionId, state.view, save]);

  const remember = useCallback(() => {
    const state = current.current;
    const { pan, zoom, focusId, viewMode, selectedIds, drawerTab, drawerOpen } = state.view;
    const previous = { pan, zoom, focusId, viewMode, selectedIds, drawerTab, drawerOpen };
    commit({ ...state, history: [...state.history.slice(-11), previous] });
  }, [commit]);

  const back = useCallback(() => {
    const state = current.current;
    const previous = state.history.at(-1);
    if (!previous) return null;
    commit({ ...state, view: { ...state.view, ...previous }, history: state.history.slice(0, -1) });
    return previous;
  }, [commit]);

  // Canvas gestures and the resize handle accept React-style field setters.
  const setPan = useCallback((value) => update((view) => ({ pan: typeof value === "function" ? value(view.pan) : value })), [update]);
  const setZoom = useCallback((value) => update((view) => ({ zoom: typeof value === "function" ? value(view.zoom) : value })), [update]);
  const setDrawerWidth = useCallback((value) => update((view) => ({ drawerWidth: typeof value === "function" ? value(view.drawerWidth) : value })), [update]);

  return {
    view: state.view,
    selectedId: state.view.selectedIds.length === 1 ? state.view.selectedIds[0] : null,
    canGoBack: state.history.length > 0,
    update, restore, save, remember, back, setPan, setZoom, setDrawerWidth,
  };
}
