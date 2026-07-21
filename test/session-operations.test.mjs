import assert from "node:assert/strict";
import test from "node:test";
import { applyOperation, resolveQuoteSpan, SessionOperationError } from "../server/sessionOperations.mjs";
import { SESSION_SCHEMA_VERSION, UNTITLED_SESSION_TITLE } from "../server/sessionStore.mjs";

function blankSession() {
  const timestamp = "2026-07-20T12:00:00.000Z";
  return {
    schema_version: SESSION_SCHEMA_VERSION,
    id: "session-test",
    title: UNTITLED_SESSION_TITLE,
    revision: 0,
    created_at: timestamp,
    updated_at: timestamp,
    transcript: [],
    nodes: [],
    edges: [],
    proposals: [],
    operations: [],
    history_cursor: 0,
  };
}

function harness(initial = blankSession()) {
  let session = initial;
  let id = 0;
  let second = 0;
  return {
    get session() { return session; },
    apply(operation, options = {}) {
      const result = applyOperation(session, operation, {
        idFactory: (kind) => `${kind}-${++id}`,
        now: () => new Date(Date.UTC(2026, 6, 20, 12, 0, second++)),
        ...options,
      });
      session = result.session;
      return result;
    },
  };
}

function appendUserTurn(h, text = "The voice agent should keep an exact transcript and exact transcript spans") {
  return h.apply({
    type: "append_utterance",
    speaker: "you",
    text,
    realtime_item_id: "input-item-1",
    expected_revision: h.session.revision,
  });
}

function createRoot(h, text = "Voice agent") {
  return h.apply({ type: "create_bubble", text, expected_revision: h.session.revision, actor: "partner" });
}

test("transcript commits are append-only, non-semantic, and idempotent by realtime item", () => {
  const h = harness();
  const first = appendUserTurn(h);
  assert.equal(first.revision, 0);
  assert.equal(h.session.transcript.length, 1);
  assert.equal(h.session.operations.length, 1);
  assert.equal(h.session.history_cursor, 0);

  const replay = h.apply({
    type: "append_utterance",
    speaker: "you",
    text: "A different duplicate payload must not replace the transcript",
    realtime_item_id: "input-item-1",
    call_id: "retry-call",
    expected_revision: 0,
  });
  assert.equal(replay.replayed, true);
  assert.equal(h.session.transcript.length, 1);
  assert.equal(h.session.transcript[0].text, "The voice agent should keep an exact transcript and exact transcript spans");
});

test("resolves exact transcript quotes and rejects missing or ambiguous quotes", () => {
  const h = harness();
  appendUserTurn(h, "exact phrase then exact phrase");
  assert.throws(
    () => resolveQuoteSpan(h.session, { utterance_id: h.session.transcript[0].id, quote: "exact phrase" }),
    (error) => error.code === "ambiguous_quote" && error.retryable,
  );
  assert.throws(
    () => resolveQuoteSpan(h.session, { utterance_id: h.session.transcript[0].id, quote: "not here" }),
    (error) => error.code === "quote_not_found" && error.retryable,
  );
  assert.deepEqual(
    resolveQuoteSpan(h.session, { utterance_id: h.session.transcript[0].id, quote: "then" }),
    { utterance_id: h.session.transcript[0].id, start: 13, end: 17, quote: "then" },
  );
});

test("returns transcript_pending without persisting a failed call_id", () => {
  const h = harness();
  assert.throws(
    () => h.apply({
      type: "create_bubble",
      text: "Buffered idea",
      quote: "Buffered idea",
      realtime_item_id: "pending-input",
      call_id: "call-pending",
      expected_revision: 0,
      actor: "partner",
    }),
    (error) => error.code === "transcript_pending" && error.retryable,
  );
  assert.equal(h.session.operations.length, 0);

  h.apply({
    type: "append_utterance",
    speaker: "you",
    text: "Buffered idea",
    realtime_item_id: "pending-input",
    expected_revision: 0,
  });
  const created = h.apply({
    type: "create_bubble",
    text: "Buffered idea",
    quote: "Buffered idea",
    realtime_item_id: "pending-input",
    call_id: "call-pending",
    expected_revision: 0,
    actor: "partner",
  });
  assert.equal(created.replayed, false);
  assert.equal(h.session.nodes.length, 1);
});

test("all speech-derived mutations wait for their completed transcript item", () => {
  const h = harness();
  createRoot(h, "Root");
  h.apply({ type: "create_bubble", text: "Other", expected_revision: 1 });
  assert.throws(
    () => h.apply({
      type: "connect_bubbles",
      from: h.session.nodes[0].id,
      to: h.session.nodes[1].id,
      realtime_item_id: "input-not-final",
      expected_revision: 2,
      actor: "partner",
    }),
    (error) => error.code === "transcript_pending" && error.retryable,
  );
  assert.equal(h.session.edges.length, 0);
});

test("the curator cannot mutate the map directly", () => {
  const h = harness();
  assert.throws(
    () => h.apply({
      type: "create_bubble",
      text: "Direct curator change",
      actor: "curator",
      expected_revision: 0,
    }),
    (error) => error.code === "curator_proposal_only" && error.status === 403,
  );
  assert.equal(h.session.nodes.length, 0);
});

test("creates, edits, revisits, connects, moves, and deletes through reversible history", () => {
  const h = harness();
  appendUserTurn(h);
  const rootResult = h.apply({
    type: "create_bubble",
    text: "Exact transcript",
    quote: "exact transcript spans",
    utterance_id: h.session.transcript[0].id,
    actor: "partner",
    expected_revision: 0,
  });
  const root = h.session.nodes[0];
  assert.equal(h.session.title, "Exact transcript");
  assert.equal(root.sources[0].quote, "exact transcript spans");
  assert.equal(rootResult.revision, 1);

  h.apply({
    type: "create_bubble",
    text: "Source spans",
    parent: root.id,
    actor: "partner",
    expected_revision: 1,
  });
  const child = h.session.nodes[1];
  assert.equal(h.session.edges.length, 1);
  assert.equal(child.depth, 1);

  h.apply({ type: "edit_bubble", node_id: child.id, text: "Exact source spans", expected_revision: 2 });
  h.apply({ type: "revisit_bubble", node_id: child.id, expected_revision: 3, actor: "partner" });
  assert.ok(h.session.nodes[1].heat_at);
  h.apply({ type: "move_bubble", node_id: child.id, x: 320, y: -40, expected_revision: 4 });
  assert.deepEqual([h.session.nodes[1].x, h.session.nodes[1].y], [320, -40]);

  const edgeId = h.session.edges[0].id;
  h.apply({ type: "delete_connection", edge_id: edgeId, expected_revision: 5 });
  assert.equal(h.session.edges.length, 0);
  h.apply({ type: "undo_map_change", expected_revision: 6 });
  assert.equal(h.session.edges.length, 1);
  h.apply({ type: "redo_map_change", expected_revision: 7 });
  assert.equal(h.session.edges.length, 0);
  assert.equal(h.session.transcript.length, 1, "map history never rewinds transcript");
  assert.equal(h.session.operations.at(-2).type, "undo_map_change");
  assert.equal(h.session.operations.at(-1).type, "redo_map_change");
});

test("repeated create warms the existing bubble instead of duplicating it", () => {
  const h = harness();
  createRoot(h, "One idea");
  const result = h.apply({
    type: "create_bubble",
    text: "one idea",
    actor: "partner",
    expected_revision: 1,
  });
  assert.equal(h.session.nodes.length, 1);
  assert.equal(result.effective_type, "revisit_bubble");
  assert.ok(h.session.nodes[0].heat_at);
});

test("one completed utterance can contribute no more than three bubbles", () => {
  const h = harness();
  appendUserTurn(h, "Alpha idea. Beta idea. Gamma idea. Delta idea.");
  const utteranceId = h.session.transcript[0].id;
  for (const [text, quote] of [
    ["Alpha", "Alpha idea"],
    ["Beta", "Beta idea"],
    ["Gamma", "Gamma idea"],
  ]) {
    h.apply({
      type: "create_bubble",
      text,
      quote,
      utterance_id: utteranceId,
      actor: "partner",
      expected_revision: h.session.revision,
    });
  }

  assert.throws(
    () => h.apply({
      type: "create_bubble",
      text: "Delta",
      quote: "Delta idea",
      utterance_id: utteranceId,
      actor: "partner",
      expected_revision: h.session.revision,
    }),
    (error) => error.code === "utterance_bubble_limit" && error.retryable,
  );
  assert.equal(h.session.nodes.length, 3);
});

test("resolves $selected only for exactly one selected bubble", () => {
  const h = harness();
  createRoot(h);
  const root = h.session.nodes[0];
  h.apply({
    type: "edit_bubble",
    node_id: "$selected",
    text: "Selected bubble",
    selected_node_ids: [root.id],
    expected_revision: 1,
  });
  assert.equal(h.session.nodes[0].text, "Selected bubble");

  assert.throws(
    () => h.apply({
      type: "edit_bubble",
      node_id: "$selected",
      text: "No target",
      selected_node_ids: [],
      expected_revision: 2,
    }),
    (error) => error.code === "selection_clarification_required" && error.retryable,
  );
});

test("protects the anchor and bulk deletion is one reversible map change", () => {
  const h = harness();
  createRoot(h);
  const root = h.session.nodes[0];
  h.apply({ type: "create_bubble", text: "Child A", parent: root.id, expected_revision: 1 });
  h.apply({ type: "create_bubble", text: "Child B", parent: root.id, expected_revision: 2 });
  const children = h.session.nodes.slice(1).map(({ id }) => id);

  assert.throws(
    () => h.apply({ type: "delete_bubble", node_id: root.id, expected_revision: 3 }),
    (error) => error.code === "anchor_protected",
  );
  const removed = h.apply({
    type: "bulk_delete_bubbles",
    node_ids: [root.id, ...children],
    expected_revision: 3,
  });
  assert.equal(h.session.nodes.length, 1);
  assert.equal(h.session.edges.length, 0);
  assert.match(removed.warnings.join(" "), /anchor/i);
  assert.equal(h.session.operations.at(-1).undoable, true);

  h.apply({ type: "undo_map_change", expected_revision: 4 });
  assert.equal(h.session.nodes.length, 3);
  assert.equal(h.session.edges.length, 2);
});

test("revision conflicts and duplicate call IDs cannot overwrite or replay a mutation", () => {
  const h = harness();
  createRoot(h);
  assert.throws(
    () => h.apply({ type: "create_bubble", text: "Stale", expected_revision: 0 }),
    (error) => error.code === "revision_conflict" && error.snapshot.revision === 1,
  );

  const child = h.apply({
    type: "create_bubble",
    text: "Idempotent",
    expected_revision: 1,
    call_id: "realtime-call-1",
  });
  const replay = h.apply({
    type: "create_bubble",
    text: "Must not appear",
    expected_revision: 1,
    call_id: "realtime-call-1",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.operation_id, child.operation_id);
  assert.equal(h.session.nodes.length, 2);
});

test("proposal exclusion, rebase, duplicate dropping, acceptance, and undo are atomic", () => {
  const h = harness();
  createRoot(h, "Root");
  const root = h.session.nodes[0];
  h.apply({ type: "create_bubble", text: "Existing", expected_revision: 1 });
  const existing = h.session.nodes[1];
  const proposal = h.apply({
    type: "propose_changes",
    actor: "curator",
    rationale: "Add a related idea and clean up an uncertain branch.",
    evidence: [],
    expected_revision: 2,
    operations: [
      { id: "proposal-op-create", type: "create_bubble", node_id: "proposed-node", text: "Proposed" },
      { id: "proposal-op-connect", type: "connect_bubbles", from: root.id, to: "proposed-node" },
      { id: "proposal-op-exclude", type: "delete_bubble", node_id: existing.id },
    ],
  });
  const proposalId = proposal.affected_ids[0];
  assert.equal(h.session.proposals[0].base_revision, 2);

  h.apply({
    type: "exclude_proposal_operation",
    proposal_id: proposalId,
    proposal_operation_id: "proposal-op-exclude",
    expected_revision: 3,
    actor: "partner",
  });
  const accepted = h.apply({
    type: "accept_proposal",
    proposal_id: proposalId,
    expected_revision: 4,
    actor: "you",
  });
  assert.equal(accepted.proposal_status, "accepted");
  assert.ok(h.session.nodes.some(({ id }) => id === "proposed-node"));
  assert.ok(h.session.nodes.some(({ id }) => id === existing.id), "excluded deletion is not applied");
  assert.equal(h.session.edges.length, 1);
  assert.deepEqual(Object.values(accepted.connection_animation_delays), [0]);

  h.apply({ type: "undo_map_change", expected_revision: 5 });
  assert.equal(h.session.nodes.some(({ id }) => id === "proposed-node"), false);
  assert.equal(h.session.proposals[0].status, "pending");
  assert.equal(h.session.transcript.length, 0);
  h.apply({ type: "redo_map_change", expected_revision: 6 });
  assert.equal(h.session.nodes.some(({ id }) => id === "proposed-node"), true);
  assert.equal(h.session.proposals[0].status, "accepted");
});

test("proposal acceptance drops duplicate and invalid operations and reports fully stale", () => {
  const h = harness();
  createRoot(h, "Root");
  const root = h.session.nodes[0];
  h.apply({ type: "create_bubble", text: "Other", expected_revision: 1 });
  const other = h.session.nodes[1];
  h.apply({ type: "connect_bubbles", from: root.id, to: other.id, expected_revision: 2 });
  const proposal = h.apply({
    type: "propose_changes",
    actor: "curator",
    rationale: "This link may already exist.",
    expected_revision: 3,
    operations: [
      { id: "duplicate-link", type: "connect_bubbles", from: root.id, to: other.id },
      { id: "protected-delete", type: "delete_bubble", node_id: root.id },
    ],
  });
  const accepted = h.apply({
    type: "accept_proposal",
    proposal_id: proposal.affected_ids[0],
    actor: "you",
    expected_revision: 4,
  });
  assert.equal(accepted.proposal_status, "stale");
  assert.match(accepted.warnings.join(" "), /fully stale/i);
  assert.equal(h.session.edges.length, 1);
  assert.equal(h.session.nodes.length, 2);
  h.apply({
    type: "dismiss_proposal",
    proposal_id: proposal.affected_ids[0],
    actor: "you",
    expected_revision: 5,
  });
  assert.equal(h.session.proposals[0].status, "dismissed");
});
