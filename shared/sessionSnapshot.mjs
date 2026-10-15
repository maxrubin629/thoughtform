import { suggestionDisplayText } from "./presentationText.mjs";

// Display projection only. Persist the full session, including operation deltas.
export function sessionSnapshot(session, { uiContext, controllerEventEpoch = 0, controllerEventSequence = 0, controllerStatus = "idle" } = {}) {
    const nodeIds = new Set(session.nodes.map((node) => node.id));
    const storedContext = uiContext ?? {
      selected_node_ids: [],
      selected_proposal_id: null,
      focus_id: null,
      view_mode: "clusters",
      voice_mode: "vad",
    };
    const context = {
      ...storedContext,
      selected_node_ids: (storedContext.selected_node_ids ?? []).filter((id) => nodeIds.has(id)),
      selected_proposal_id: session.proposals.some((proposal) => proposal.id === storedContext.selected_proposal_id && ["pending", "stale"].includes(proposal.status)) ? storedContext.selected_proposal_id : null,
      focus_id: nodeIds.has(storedContext.focus_id) ? storedContext.focus_id : null,
    };
    const history = [...session.operations].reverse()
      .find((operation) => Array.isArray(operation.history_entry_ids))?.history_entry_ids ?? [];
    const operations = session.operations.map(({ change: _change, history_entry_ids: _history, ...record }) => record);
    const labelFor = (id) => {
      const operation = operations.find((entry) => entry.id === id);
      if (!operation) return null;
      return suggestionDisplayText(operation.label) || ({
        create_bubble: "Add thought", edit_bubble: "Edit thought", move_bubble: "Move thought",
        delete_bubble: "Remove thought", connect_bubbles: "Connect thoughts", delete_connection: "Remove connection",
        apply_map_batch: "Partner’s latest interpretation", accept_proposal: "Accept suggestion",
        set_node_pinned: "Change pinned position", set_node_parked: "Keep thought aside",
      }[operation.type] ?? "Latest map change");
    };
    const { transcript_fragments = [], live_capture, ...publicSession } = session;
    return {
      ...publicSession,
      preferences: session.preferences ?? { mapping_paused: false, partner_mode: "proactive" },
      synthesis: session.synthesis ?? null,
      capture_status: {
        pending_fragments: Math.max(0, transcript_fragments.length - (live_capture?.consumed_fragment_ids?.length ?? 0)),
        last_error: live_capture?.last_error ?? null,
      },
      controller_event_epoch: controllerEventEpoch,
      controller_event_sequence: controllerEventSequence,
      map_controller: {
        ...session.map_controller,
        status: controllerStatus,
      },
      operations,
      history_length: history.length,
      undo_label: labelFor(history[session.history_cursor - 1]),
      redo_label: labelFor(history[session.history_cursor]),
      ui_context: context,
    };
}
