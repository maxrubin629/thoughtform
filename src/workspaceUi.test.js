import assert from "node:assert/strict";
import test from "node:test";
import { BASE_HEIGHT, BASE_WIDTH } from "./mapData.js";
import { CAMERA_BASE_SCALE, cameraTransform } from "./mapCamera.js";
import {
  latestUndoLabel,
  groupUtterancesByPause,
  normalizeWorkspaceState,
  readWorkspaceState,
  recentMapChange,
  writeWorkspaceState,
  WORKSPACE_CAMERA_VERSION,
} from "./workspaceUi.js";

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function session(overrides = {}) {
  return {
    id: "session-a",
    revision: 1,
    nodes: [{ id: "root", text: "An idea", x: 0, y: 0 }],
    edges: [],
    transcript: [],
    operations: [],
    history_cursor: 0,
    ...overrides,
  };
}

test("workspace normalization bounds camera and drawer values and retains only supported fields", () => {
  assert.deepEqual(normalizeWorkspaceState({
    pan: { x: Infinity, y: -1e9 }, zoom: 4, drawer_width: 100,
    selected_ids: ["root", "root", "", null, 2, "child"],
    focus_id: "child", view_mode: "hierarchy", drawer_tab: "activity",
    drawer_open: false, show_suggestions: false,
    transcript: [{ text: "Do not persist this here" }],
  }), {
    pan: { x: 0, y: -100_000 }, zoom: 3, drawer_width: 300,
    camera_version: 0, camera_viewport_width: 0,
    selected_node_ids: ["root", "child"], focus_id: "child", view_mode: "hierarchy",
    drawer_tab: "activity", drawer_open: false, show_suggestions: false,
  });
  const invalid = normalizeWorkspaceState({ zoom: -1, drawer_width: 999, view_mode: "other", drawer_tab: "other", drawer_open: "false", focus_id: {} });
  assert.equal(invalid.zoom, 0.25);
  assert.equal(invalid.drawer_width, 560);
  assert.equal(invalid.view_mode, "clusters");
  assert.equal(invalid.drawer_tab, "conversation");
  assert.equal(invalid.drawer_open, false);
  assert.equal(invalid.focus_id, null);
  assert.equal(normalizeWorkspaceState(null).drawer_width, 360);
  assert.equal(normalizeWorkspaceState(null).drawer_open, false);
  assert.equal(normalizeWorkspaceState({ drawer_tab: "sources" }).drawer_tab, "sources");
  assert.deepEqual(normalizeWorkspaceState({ selected_node_ids: ["new"], selected_ids: ["old"] }).selected_node_ids, ["new"]);
  for (const version of [undefined, 0, 1, 4, "2", null]) {
    assert.equal(normalizeWorkspaceState({ camera_version: version }).camera_version, 0);
  }
  assert.equal(normalizeWorkspaceState({ camera_version: 2 }).camera_version, WORKSPACE_CAMERA_VERSION);
  assert.equal(normalizeWorkspaceState({ camera_viewport_width: Infinity }).camera_viewport_width, 0);
  assert.equal(normalizeWorkspaceState({ camera_viewport_width: -12 }).camera_viewport_width, 0);
  assert.equal(normalizeWorkspaceState({ camera_viewport_width: 30_000 }).camera_viewport_width, 20_000);
});

test("workspace storage isolates sessions and restores selection and camera without canonical content", () => {
  const storage = memoryStorage();
  const view = { pan: { x: 56, y: -29 }, zoom: 1.2, selected_node_ids: ["child"], focus_id: "root", drawer_width: 450, show_suggestions: false };
  assert.equal(writeWorkspaceState("first/session", view, storage), true);
  assert.equal(writeWorkspaceState("other", { zoom: 0.8 }, storage), true);
  assert.deepEqual(readWorkspaceState("first/session", storage), normalizeWorkspaceState(view));
  assert.equal(readWorkspaceState("other", storage).zoom, 0.8);
  assert.deepEqual(readWorkspaceState("missing", storage), normalizeWorkspaceState());
  assert.equal(storage.values.size, 2);
  assert.equal(writeWorkspaceState("", view, storage), false);
});

test("workspace storage preserves the relative camera and its initialization metadata", () => {
  const storage = memoryStorage();
  const view = {
    pan: { x: -425, y: 118 }, zoom: 3,
    camera_version: WORKSPACE_CAMERA_VERSION, camera_viewport_width: 390,
    selected_node_ids: ["child"], drawer_tab: "sources", drawer_open: true, drawer_width: 420,
  };
  assert.equal(writeWorkspaceState("mobile", view, storage), true);
  assert.deepEqual(readWorkspaceState("mobile", storage), normalizeWorkspaceState(view));
  const saved = JSON.parse(storage.values.get("thoughtform.workspace.v1:mobile"));
  assert.equal(saved.version, 1);
  assert.equal(saved.state.zoom, 3);
  assert.equal(saved.state.camera_version, WORKSPACE_CAMERA_VERSION);
  assert.equal(saved.state.camera_viewport_width, 390);
});

test("old absolute-scale views migrate once without changing their rendered position or size", () => {
  const oldView = { camera_version: 2, camera_viewport_width: 877, zoom: 0.55, pan: { x: 24, y: -17 } };
  const viewport = { width: 877, height: 897 };
  const migrated = normalizeWorkspaceState(oldView);
  assert.equal(migrated.zoom, oldView.zoom / CAMERA_BASE_SCALE);
  assert.equal(migrated.camera_version, WORKSPACE_CAMERA_VERSION);
  assert.deepEqual(cameraTransform(viewport, migrated.zoom, migrated.pan), {
    scale: oldView.zoom,
    offsetX: (viewport.width - BASE_WIDTH * oldView.zoom) / 2 + oldView.pan.x,
    offsetY: (viewport.height - BASE_HEIGHT * oldView.zoom) / 2 + oldView.pan.y,
  });
  assert.deepEqual(normalizeWorkspaceState(migrated), migrated);
  assert.equal(oldView.camera_version, 2);
  assert.equal(oldView.zoom, 0.55);
});

test("legacy views retain pan, selection and drawer state without being marked initialized", () => {
  const storage = memoryStorage();
  const oldView = {
    pan: { x: 135, y: -62 }, zoom: 1.36, selected_ids: ["root", "child"], focus_id: "child",
    view_mode: "hierarchy", drawer_tab: "sources", drawer_open: true, drawer_width: 460,
    show_suggestions: false,
  };
  storage.values.set("thoughtform.workspace.v1:legacy", JSON.stringify({ version: 1, session_id: "legacy", state: oldView }));
  const restored = readWorkspaceState("legacy", storage);
  assert.deepEqual(restored.pan, oldView.pan);
  assert.equal(restored.zoom, oldView.zoom);
  assert.deepEqual(restored.selected_node_ids, oldView.selected_ids);
  assert.equal(restored.focus_id, oldView.focus_id);
  assert.equal(restored.view_mode, oldView.view_mode);
  assert.equal(restored.drawer_tab, oldView.drawer_tab);
  assert.equal(restored.drawer_open, oldView.drawer_open);
  assert.equal(restored.drawer_width, oldView.drawer_width);
  assert.equal(restored.show_suggestions, oldView.show_suggestions);
  assert.equal(restored.camera_version, 0);
  assert.equal(restored.camera_viewport_width, 0);
  assert.equal(writeWorkspaceState("legacy", restored, storage), true);
  assert.deepEqual(readWorkspaceState("legacy", storage), restored);
  assert.equal(JSON.parse(storage.values.get("thoughtform.workspace.v1:legacy")).state.camera_version, 0);
});

test("corrupt, incompatible and mismatched saved views safely use defaults", () => {
  const storage = memoryStorage();
  writeWorkspaceState("a", { zoom: 1.2 }, storage);
  const key = [...storage.values.keys()][0];
  for (const invalid of ["broken JSON", "null", "[]", JSON.stringify({ version: 2, session_id: "a", state: { zoom: 1.2 } }), JSON.stringify({ version: 1, session_id: "b", state: { zoom: 1.2 } })]) {
    storage.values.set(key, invalid);
    assert.deepEqual(readWorkspaceState("a", storage), normalizeWorkspaceState());
  }
  const unavailable = { getItem() { throw new Error("Blocked"); }, setItem() { throw new Error("Quota exceeded"); } };
  assert.deepEqual(readWorkspaceState("a", unavailable), normalizeWorkspaceState());
  assert.equal(writeWorkspaceState("a", {}, unavailable), false);
});

test("recent changes ignore transcript, preferences, pending proposals and session loads", () => {
  const before = session();
  const after = session({ revision: 5, transcript: [{ id: "u", text: "Another thought" }], preferences: { mapping_paused: true }, proposals: [{ id: "p" }], operations: [{ id: "append", type: "append_utterance" }] });
  assert.equal(recentMapChange(before, after), null);
  assert.equal(recentMapChange(null, after), null);
  assert.equal(recentMapChange(before, session({ id: "other", nodes: [] })), null);
  assert.equal(recentMapChange(before, session({ nodes: [...before.nodes].reverse() })), null);
});

test("recent graph changes choose the latest actual mutation and identify live endpoint nodes", () => {
  const before = session({ nodes: [{ id: "root", text: "An idea" }, { id: "child", text: "Detail" }] });
  const after = session({
    nodes: before.nodes,
    edges: [{ id: "edge", from: "root", to: "child" }],
    operations: [
      { id: "connect", type: "connect_bubbles", undoable: true, affected_ids: ["edge"] },
      { id: "noop", type: "connect_bubbles", undoable: false, affected_ids: ["edge"] },
      { id: "utterance", type: "append_utterance" },
      { id: "suggestion", type: "propose_changes" },
    ],
  });
  assert.deepEqual(recentMapChange(before, after), { label: "Connected thoughts", nodeIds: ["root", "child"], operationId: "connect" });
  const removed = session({ operations: [{ id: "delete", type: "delete_bubble", undoable: true, affected_ids: ["child", "edge"] }] });
  assert.deepEqual(recentMapChange(after, removed), { label: "Removed a thought", nodeIds: ["root"], operationId: "delete" });
});

test("batch changes keep their interpretation label and undo events can mark changed thoughts", () => {
  const before = session();
  const after = session({ nodes: [...before.nodes, { id: "child", text: "Detail" }], operations: [{ id: "batch", type: "apply_map_batch", label: "Split this thought", affected_ids: ["child"], undoable: true }] });
  assert.deepEqual(recentMapChange(before, after), { label: "Split this thought", nodeIds: ["child"], operationId: "batch" });
  const undone = session({ operations: [...after.operations, { id: "undo", type: "undo_map_change", affected_ids: ["child"], undoable: false, target_operation_id: "batch" }] });
  assert.equal(recentMapChange(after, undone).label, "Undid a map change");
});

test("undo labels use the active history branch and cursor, not simply the newest operation", () => {
  const operations = [
    { id: "first", type: "create_bubble", undoable: true },
    { id: "abandoned", type: "delete_bubble", undoable: true },
    { id: "third", type: "connect_bubbles", undoable: true },
    { id: "append", type: "append_utterance", history_entry_ids: ["first", "third"] },
  ];
  assert.equal(latestUndoLabel(session({ operations, history_cursor: 2 })), "Undo connecting thoughts");
  assert.equal(latestUndoLabel(session({ operations, history_cursor: 1 })), "Undo creating a thought");
  assert.equal(latestUndoLabel(session({ operations, history_cursor: 0, undo_label: "Stale label" })), "Undo map change");
  assert.equal(latestUndoLabel(session({ operations, history_cursor: 2, undo_label: "Undo splitting this thought" })), "Undo splitting this thought");
});

test("pinning and parking changes retain their human operation labels", () => {
  const before = session();
  for (const [type, field, label] of [["set_node_pinned", "pinned", "Pinned a bubble"], ["set_node_parked", "parked", "Kept a thought aside"]]) {
    const after = session({
      nodes: [{ ...before.nodes[0], [field]: true }],
      operations: [{ id: type, type, undoable: true, affected_ids: ["root"], label }],
    });
    assert.deepEqual(recentMapChange(before, after), { label, nodeIds: ["root"], operationId: type });
  }
});


test("server undo descriptions receive an action prefix only once", () => {
  assert.equal(latestUndoLabel({ history_cursor: 1, undo_label: "Partner’s latest interpretation" }), "Undo Partner’s latest interpretation");
  assert.equal(latestUndoLabel({ history_cursor: 1, undo_label: "Undo splitting a thought" }), "Undo splitting a thought");
});


test("conversation keeps adjacent fragments together and exposes a long pause without changing originals", () => {
  const first = { id: "first", text: "A thought", completed_at: "2026-09-17T16:12:00Z" };
  const second = { id: "second", text: "in fragments", completed_at: "2026-09-17T16:12:04Z" };
  const later = { id: "later", text: "A later thought", completed_at: "2026-09-17T16:21:00Z" };
  assert.deepEqual(groupUtterancesByPause([first, second, later]), [[first, second], [later]]);
  assert.equal(groupUtterancesByPause([first, second])[0][0], first);
  assert.deepEqual(groupUtterancesByPause([]), []);
  assert.equal(groupUtterancesByPause([{ id: "unknown" }, later]).length, 1);
});
