import assert from "node:assert/strict";
import test from "node:test";
import { sessionSnapshot } from "../shared/sessionSnapshot.mjs";
import { suggestionDisplayText } from "../shared/presentationText.mjs";
import { activityLabel } from "./session/presentation.js";
import { latestUndoLabel, recentMapChange } from "./workspaceUi.js";

test("legacy labels use suggestion wording without rewriting the saved session or source text", () => {
  const saved = {
    id: "legacy",
    nodes: [{ id: "node", text: "A grant proposal", sources: [{ utterance_id: "u", start: 0, end: 16, quote: "A grant proposal" }] }],
    edges: [],
    proposals: [],
    transcript: [{ id: "u", text: "A grant proposal" }],
    operations: [
      { id: "first", type: "accept_proposal", label: "Accepted a Proposal", undoable: true, affected_ids: ["node"] },
      { id: "second", type: "accept_proposal", label: "Accepted PROPOSALS", undoable: true, affected_ids: ["node"], history_entry_ids: ["first", "second"] },
    ],
    history_cursor: 1,
  };
  const original = JSON.stringify(saved);
  const snapshot = sessionSnapshot(saved);

  assert.equal(activityLabel(snapshot.operations[0]), "Accepted a Suggestion");
  assert.equal(snapshot.undo_label, "Accepted a Suggestion");
  assert.equal(snapshot.redo_label, "Accepted SUGGESTIONS");
  assert.equal(latestUndoLabel(snapshot), "Undo Accepted a Suggestion");
  assert.equal(latestUndoLabel(saved), "Undo Accepted a Suggestion");
  assert.equal(recentMapChange({ ...saved, nodes: [], operations: [] }, snapshot).label, "Accepted SUGGESTIONS");
  assert.equal(JSON.stringify(saved), original);
  assert.deepEqual(snapshot.transcript, saved.transcript);
  assert.deepEqual(snapshot.nodes, saved.nodes);
  assert.equal(snapshot.operations[0].label, "Accepted a Proposal");
  assert.equal(snapshot.operations[0].type, "accept_proposal");
});

test("display wording leaves protocol identifiers and larger words intact", () => {
  assert.equal(
    suggestionDisplayText("Proposal proposal PROPOSALS: proposal_id, proposal-operation, counterproposal"),
    "Suggestion suggestion SUGGESTIONS: proposal_id, proposal-operation, counterproposal",
  );
  assert.equal(suggestionDisplayText(null), null);
});
