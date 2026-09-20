const STORAGE_VERSION = 1;
const STORAGE_PREFIX = "thoughtform.workspace.v1:";
const DRAWER_TABS = new Set([
  "maps", "conversation", "activity", "search", "proposals", "layouts",
  "overview", "layers", "profile", "settings", "sources",
]);

const validId = (value) => typeof value === "string" && value.trim().length > 0;
const bounded = (value, fallback, min, max) => (
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
);

/** Browser-only view state. Canonical graph and transcript data never belong here. */
export function normalizeWorkspaceState(state) {
  const value = state && typeof state === "object" && !Array.isArray(state) ? state : {};
  const selection = value.selected_node_ids ?? value.selected_ids;
  return {
    pan: {
      x: bounded(value.pan?.x, 0, -100_000, 100_000),
      y: bounded(value.pan?.y, 0, -100_000, 100_000),
    },
    zoom: bounded(value.zoom, 1, 0.72, 1.36),
    selected_node_ids: Array.isArray(selection) ? [...new Set(selection.filter(validId))] : [],
    focus_id: validId(value.focus_id) ? value.focus_id : null,
    view_mode: value.view_mode === "hierarchy" ? "hierarchy" : "clusters",
    drawer_tab: DRAWER_TABS.has(value.drawer_tab) ? value.drawer_tab : "conversation",
    drawer_open: typeof value.drawer_open === "boolean" ? value.drawer_open : false,
    drawer_width: bounded(value.drawer_width, 360, 300, 560),
    show_suggestions: typeof value.show_suggestions === "boolean" ? value.show_suggestions : true,
  };
}

export function readWorkspaceState(sessionId, storage) {
  if (!validId(sessionId)) return normalizeWorkspaceState();
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    const saved = JSON.parse(target?.getItem(`${STORAGE_PREFIX}${encodeURIComponent(sessionId)}`) ?? "null");
    if (saved?.version !== STORAGE_VERSION || saved?.session_id !== sessionId) return normalizeWorkspaceState();
    return normalizeWorkspaceState(saved.state);
  } catch {
    // Disabled storage and a corrupt saved view must not prevent opening a map.
    return normalizeWorkspaceState();
  }
}

export function writeWorkspaceState(sessionId, state, storage) {
  if (!validId(sessionId)) return false;
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    if (!target?.setItem) return false;
    target.setItem(`${STORAGE_PREFIX}${encodeURIComponent(sessionId)}`, JSON.stringify({
      version: STORAGE_VERSION,
      session_id: sessionId,
      state: normalizeWorkspaceState(state),
    }));
    return true;
  } catch {
    return false;
  }
}

const CHANGE_LABELS = {
  create_bubble: "Added a thought",
  edit_bubble: "Edited a thought",
  revisit_bubble: "Revisited a thought",
  set_central_idea: "Changed the central idea",
  connect_bubbles: "Connected thoughts",
  delete_bubble: "Removed a thought",
  bulk_delete_bubbles: "Removed thoughts",
  delete_connection: "Removed a connection",
  move_bubble: "Moved a thought",
  set_node_pinned: "Changed a thought's pinned position",
  set_node_parked: "Changed a thought's focus",
  apply_map_batch: "Organized the map",
  accept_proposal: "Accepted a suggestion",
  undo_map_change: "Undid a map change",
  redo_map_change: "Redid a map change",
};

const UNDO_LABELS = {
  create_bubble: "creating a thought",
  edit_bubble: "editing a thought",
  revisit_bubble: "revisiting a thought",
  set_central_idea: "changing the central idea",
  connect_bubbles: "connecting thoughts",
  delete_bubble: "removing a thought",
  bulk_delete_bubbles: "removing thoughts",
  delete_connection: "removing a connection",
  move_bubble: "moving a thought",
  set_node_pinned: "changing a thought's pinned position",
  set_node_parked: "changing a thought's focus",
  apply_map_batch: "organizing the map",
  accept_proposal: "accepting a suggestion",
};

function changedEntities(before = [], after = []) {
  const prior = new Map(before.map((entity) => [entity.id, entity]));
  const next = new Map(after.map((entity) => [entity.id, entity]));
  return [...new Set([...prior.keys(), ...next.keys()])]
    .filter((id) => JSON.stringify(prior.get(id)) !== JSON.stringify(next.get(id)))
    .map((id) => ({ id, before: prior.get(id), after: next.get(id) }));
}

/** Identify actual graph changes, ignoring transcript, proposal and preference updates. */
export function recentMapChange(previous, next) {
  if (!previous || !next || previous.id !== next.id) return null;
  const nodes = changedEntities(previous.nodes, next.nodes);
  const edges = changedEntities(previous.edges, next.edges);
  if (!nodes.length && !edges.length) return null;

  const changedIds = new Set([...nodes, ...edges].map(({ id }) => id));
  const previousOperationIds = new Set((previous.operations ?? []).map(({ id }) => id));
  const operation = [...(next.operations ?? [])].reverse().find((entry) => (
    !previousOperationIds.has(entry.id)
    && CHANGE_LABELS[entry.type]
    && (entry.undoable !== false || entry.type === "undo_map_change" || entry.type === "redo_map_change")
    && (!entry.affected_ids?.length || entry.affected_ids.some((id) => changedIds.has(id)))
  ));
  const affectedNodes = new Set(nodes.map(({ id }) => id));
  for (const edge of edges) {
    for (const entity of [edge.before, edge.after]) {
      if (entity?.from) affectedNodes.add(entity.from);
      if (entity?.to) affectedNodes.add(entity.to);
    }
  }
  const liveNodeIds = new Set((next.nodes ?? []).map(({ id }) => id));
  return {
    label: operation?.label?.trim() || CHANGE_LABELS[operation?.type] || "Updated the map",
    nodeIds: [...affectedNodes].filter((id) => liveNodeIds.has(id)),
    operationId: operation?.id ?? null,
  };
}

/** Full accessible button label. Prefer server history metadata when available. */
export function latestUndoLabel(session) {
  const cursor = session?.history_cursor ?? 0;
  if (cursor <= 0) return "Undo map change";
  if (typeof session.undo_label === "string" && session.undo_label.trim()) {
    const label = session.undo_label.trim();
    return /^undo\b/i.test(label) ? label : `Undo ${label}`;
  }
  const operations = session.operations ?? [];
  const history = [...operations].reverse().find((entry) => Array.isArray(entry.history_entry_ids))?.history_entry_ids;
  const target = history
    ? operations.find(({ id }) => id === history[cursor - 1])
    : operations.filter(({ undoable }) => undoable)[cursor - 1];
  if (target?.label?.trim()) return `Undo ${target.label.trim()}`;
  return target && UNDO_LABELS[target.type] ? `Undo ${UNDO_LABELS[target.type]}` : "Undo map change";
}

/** Keep canonical turns intact while making long pauses visible in the transcript. */
export function groupUtterancesByPause(utterances = [], gapMs = 120_000) {
  const groups = [];
  utterances.forEach((utterance, index) => {
    const previousTime = Date.parse(utterances[index - 1]?.completed_at);
    const currentTime = Date.parse(utterance.completed_at);
    if (!groups.length || (Number.isFinite(previousTime) && Number.isFinite(currentTime) && currentTime - previousTime >= gapMs)) {
      groups.push([]);
    }
    groups.at(-1).push(utterance);
  });
  return groups;
}
