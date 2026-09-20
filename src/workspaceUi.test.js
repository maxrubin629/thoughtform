import assert from "node:assert/strict";
import test from "node:test";
import {
  latestUndoLabel,
  groupUtterancesByPause,
  normalizeWorkspaceState,
  readWorkspaceState,
  recentMapChange,
  writeWorkspaceState,
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
    pan: { x: 0, y: -100_000 }, zoom: 1.36, drawer_width: 300,
    selected_node_ids: ["root", "child"], focus_id: "child", view_mode: "hierarchy",
    drawer_tab: "activity", drawer_open: false, show_suggestions: false,
  });
  const invalid = normalizeWorkspaceState({ zoom: -1, drawer_width: 999, view_mode: "other", drawer_tab: "other", drawer_open: "false", focus_id: {} });
  assert.equal(invalid.zoom, 0.72);
  assert.equal(invalid.drawer_width, 560);
  assert.equal(invalid.view_mode, "clusters");
  assert.equal(invalid.drawer_tab, "conversation");
  assert.equal(invalid.drawer_open, false);
  assert.equal(invalid.focus_id, null);
  assert.equal(normalizeWorkspaceState(null).drawer_width, 360);
  assert.equal(normalizeWorkspaceState(null).drawer_open, false);
  assert.equal(normalizeWorkspaceState({ drawer_tab: "sources" }).drawer_tab, "sources");
  assert.deepEqual(normalizeWorkspaceState({ selected_node_ids: ["new"], selected_ids: ["old"] }).selected_node_ids, ["new"]);
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
