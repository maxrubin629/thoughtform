import { useWorkspaceView } from "./useWorkspaceView.js";
import { useThoughtEditor } from "./useThoughtEditor.js";
import { useMapLibrary } from "./useMapLibrary.js";
import { nodeLabel } from "./format.js";
import { SelectionTools } from "./SelectionTools.jsx";
import { ThoughtEditor } from "./ThoughtEditor.jsx";
import { WorkspaceRail } from "./WorkspaceRail.jsx";
import { useCanonicalSession } from "./useCanonicalSession.js";
import { useSessionGraph } from "./useSessionGraph.js";
import { useSessionVoice } from "./useSessionVoice.js";
import { WorkspaceDrawer } from "./WorkspaceDrawer.jsx";
import { VoiceControls } from "./VoiceControls.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconAffiliate, IconArrowBackUp, IconArrowLeft, IconDots, IconCheck, IconFocusCentered,
  IconGridDots, IconMessageCircle, IconMinus, IconPencil, IconPlus, IconSparkles,
  IconStack2, IconTrash, IconX,
} from "@tabler/icons-react";
import { IconButton } from "../canvas/IconButton.jsx";
import { MindMap } from "../canvas/MindMap.jsx";
import { BASE_HEIGHT, BASE_WIDTH, MIN_ZOOM, MAX_ZOOM, ZOOM_STEP } from "../canvas/viewport.js";
import { clamp } from "../fluidMaterial.js";
import { buildConversationTimeline } from "../session/presentation.js";

import { downloadSessionExport } from "../workspaceApi.js";
import { latestUndoLabel } from "../workspaceUi.js";

export function Workspace() {
  const workspaceView = useWorkspaceView();
  const { view, selectedId, canGoBack, update: updateView, restore: restoreWorkspace, remember: rememberView, setPan, setZoom, setDrawerWidth } = workspaceView;
  const { selectedIds, pan, zoom, focusId, viewMode, selectionMode, drawerOpen, drawerTab, drawerWidth, showSuggestions } = view;
  const [connectFromId, setConnectFromId] = useState(null);
  const [bubbleActionsId, setBubbleActionsId] = useState(null);
  const armConnection = useCallback((id) => setConnectFromId((current) => current === id ? null : id), []);
  const cancelConnection = useCallback(() => setConnectFromId(null), []);
  const marqueeActive = selectionMode !== null;
  const [searchQuery, setSearchQuery] = useState("");
  const [showProvenance, setShowProvenance] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => (
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false
  ));
  const [chatValue, setChatValue] = useState("");
  const [highlight, setHighlight] = useState(null);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);

  const utteranceElementsRef = useRef(new Map());
  const transcriptEndRef = useRef(null);
  const chatInputRef = useRef(null);

  const showToast = useCallback((message) => setToast(message), []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selectOne = useCallback((id) => {
    updateView({ selectedIds: id ? [id] : [] });
    setBubbleActionsId(null);
  }, [updateView]);

  const graph = useSessionGraph({ viewMode, reducedMotion, showSuggestions });
  const { nodes, nodesRef, proposalNodesRef, connectionPopQueueRef, pendingProposals, ghostVisuals, mapNodes, mapEdges, applySnapshot, reset, applyViewLayout } = graph;
  const applyGraphSnapshot = useCallback((snapshot, { animateNew, switching }) => {
    if (switching) reset();
    applySnapshot(snapshot, { animateNew });
    const selectableIds = new Set(snapshot.nodes.map((node) => node.id));
    const pendingIds = new Set((snapshot.proposals ?? []).filter((proposal) => proposal.status === "pending").map((proposal) => proposal.id));
    proposalNodesRef.current.forEach((node) => { if (pendingIds.has(node.proposalId)) selectableIds.add(node.id); });
    updateView(({ selectedIds }) => {
      const next = selectedIds.filter((id) => selectableIds.has(id));
      return next.length === selectedIds.length ? null : { selectedIds: next };
    });
    if (switching) restoreWorkspace(snapshot);
  }, [applySnapshot, reset, proposalNodesRef, restoreWorkspace, updateView]);
  const session = useCanonicalSession({ onSnapshot: applyGraphSnapshot, showToast });
  const {
    canonical, canonicalRef, sessionIdRef, loading, pendingWrites, syncConnected,
    recentChange, setRecentChange, synthesis, synthesizing, requestSynthesis, preferenceBusy,
    setPreferences, controllerRetrying, retryMapController, controllerStatus,
    loadSession, perform, runCommand, command,
  } = session;
  const voice = useSessionVoice({ session, graph, selection: { selectedId, selectedIds, focusId, viewMode } });
  const { audioRef, stopRealtime, sendConversation } = voice;

  const editor = useThoughtEditor({ perform, runCommand, selectOne });
  const { composer, value: composerValue, saving: composerSaving } = editor;

  const openSession = async (id) => {
    if (!id) return;
    workspaceView.save();
    stopRealtime();
    setConnectFromId(null);
    editor.reset();
    updateView({ selectionMode: null });
    setHighlight(null);
    await loadSession(id);
  };

  const library = useMapLibrary({ session, openSession, stopRealtime });
  const { renameId, renameValue, setRenameId, setRenameValue, saveRename } = library;

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [canonical?.transcript?.length]);

  const submitChat = async (event) => {
    event.preventDefault();
    const text = chatValue.trim();
    if (!text || busy) return;
    const submittedSessionId = sessionIdRef.current;
    setChatValue("");
    setBusy(true);
    try {
      await sendConversation(text);
    } catch (error) {
      if (sessionIdRef.current === submittedSessionId) setChatValue((current) => current || text);
      showToast(error.message);
    } finally {
      setBusy(false);
    }
  };

  const connectTarget = async (targetId, sourceId = connectFromId) => {
    try {
      if (await graph.connectTarget(sourceId, targetId, perform)) selectOne(targetId);
    } catch (error) { showToast(error.message); }
    finally { setConnectFromId(null); }
  };
  const finishMoveNode = (id, vx, vy, moved) => {
    const node = graph.finishMoveNode(id, vx, vy, moved);
    if (!moved || !node || node.ghost) return;
    command({ type: "move_bubble", node_reference: id, x: node.x, y: node.y });
  };

  const rootId = useMemo(() => (
    canonical?.nodes?.find((node) => node.depth === 0)?.id ?? canonical?.nodes?.[0]?.id ?? null
  ), [canonical?.nodes]);

  const deleteBubble = (id) => {
    if (id === rootId) {
      showToast("The starting thought anchors this map");
      return;
    }
    command({ type: "delete_bubble", node_reference: id }, () => selectOne(null));
  };

  const openNewThought = () => {
    if (composerSaving) return;
    updateView({ selectionMode: null });
    setBubbleActionsId(null);
    setConnectFromId(null);
    const scale = Math.min(window.innerWidth / BASE_WIDTH, window.innerHeight / BASE_HEIGHT) * zoom;
    const shell = document.querySelector(".canonical-session-shell");
    const railWidth = shell ? parseFloat(getComputedStyle(shell).getPropertyValue("--workspace-rail-width")) || 0 : 0;
    const reservedLeft = railWidth + (drawerOpen && window.innerWidth > 820 ? drawerWidth + 12 : 0);
    editor.openNew({ position: { x: BASE_WIDTH / 2 + (reservedLeft / 2 - pan.x) / scale, y: BASE_HEIGHT / 2 - pan.y / scale } });
  };

  const deleteSelected = () => {
    const committedIds = new Set(canonicalRef.current?.nodes?.map((node) => node.id) ?? []);
    const deletable = selectedIds.filter((id) => id !== rootId && committedIds.has(id));
    if (!deletable.length) return;
    return command({ type: "bulk_delete_bubbles", node_ids: deletable }, () => updateView({ selectedIds: [] }));
  };

  const centerOnNode = (id) => {
    const node = nodesRef.current.find((candidate) => candidate.id === id);
    if (!node) return;
    const scale = Math.min(window.innerWidth / BASE_WIDTH, window.innerHeight / BASE_HEIGHT) * zoom;
    setPan({ x: (BASE_WIDTH / 2 - node.x) * scale, y: (BASE_HEIGHT / 2 - node.y) * scale });
  };

  const restorePreviousView = () => {
    const previous = workspaceView.back();
    if (previous && previous.viewMode !== viewMode) applyViewLayout(previous.viewMode);
  };
  const changeView = (nextMode) => {
    if (nextMode === viewMode) return;
    rememberView();
    applyViewLayout(nextMode);
    updateView({ viewMode: nextMode, pan: { x: 0, y: 0 }, zoom: 1, drawerOpen: false });
    showToast(nextMode === "clusters" ? "Cluster view" : "Hierarchy view");
  };

  const undo = () => command({ type: "undo_map_change" });
  const redo = () => command({ type: "redo_map_change" });

  const acceptProposal = (proposal) => command({ type: "accept_proposal", proposal_id: proposal.id }, (result) => {
    if (result?.warnings?.some((warning) => /stale/i.test(warning))) showToast("Applied what still fit; stale changes were dropped");
  });

  const dismissProposal = (proposal) => command({ type: "dismiss_proposal", proposal_id: proposal.id });

  const excludeProposalOperation = (proposal, operation) => command({
    type: "exclude_proposal_operation",
    proposal_id: proposal.id,
    operation_id: operation.id,
  });

  const openEvidence = (utteranceId, nodeId = null, spans = null) => {
    rememberView();
    updateView({ drawerOpen: true, drawerTab: "conversation" });
    setHighlight({ utteranceId, nodeId, spans });
    window.setTimeout(() => utteranceElementsRef.current.get(utteranceId)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  const askAboutBubble = (id) => {
    const node = [...nodesRef.current, ...proposalNodesRef.current].find((candidate) => candidate.id === id);
    if (!node) return;
    rememberView();
    selectOne(id);
    updateView({ drawerOpen: true, drawerTab: "conversation" });
    setChatValue(`Let’s explore ${node.ghost ? "this suggestion" : "this thought"}: “${nodeLabel(node)}”. `);
    window.setTimeout(() => chatInputRef.current?.focus(), 50);
  };

  const toggleFocus = () => {
    rememberView();
    if (focusId) {
      updateView({ focusId: null });
      showToast("Showing the full map");
    } else if (selectedId && nodesRef.current.some((node) => node.id === selectedId)) {
      updateView({ focusId: selectedId });
      centerOnNode(selectedId);
      showToast("Focused this branch");
    } else {
      showToast("Select a committed bubble first");
    }
  };

  const openDrawer = (tab) => updateView({ drawerTab: tab, drawerOpen: !(drawerOpen && drawerTab === tab) });

  useEffect(() => {
    const handleKeyDown = (event) => {
      const target = event.target;
      const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
      if (event.key === "Escape") {
        if (marqueeActive) {
          updateView({ selectionMode: null, selectedIds: [] });
        }
        editor.close();
        setConnectFromId(null);
        setBubbleActionsId(null);
        setHighlight(null);
      }
      if (!editing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const selected = mapNodes.find((node) => node.id === selectedId);
  const conversationTimeline = useMemo(
    () => buildConversationTimeline(canonical?.transcript, canonical?.operations),
    [canonical?.operations, canonical?.transcript],
  );
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return nodes.slice(0, 12);
    return nodes.filter((node) => nodeLabel(node).toLowerCase().includes(query)).slice(0, 12);
  }, [nodes, searchQuery]);

  const mappingPaused = Boolean(canonical?.preferences?.mapping_paused);
  const partnerMode = canonical?.preferences?.partner_mode ?? "proactive";
  const undoLabel = latestUndoLabel(canonical);
  const selectedCanonical = canonical?.nodes?.find((node) => node.id === selectedId);
  const selectedProposal = pendingProposals.find((proposal) => proposal.id === selected?.proposalId);
  const committedNodeIds = new Set(canonical?.nodes?.map((node) => node.id) ?? []);
  const deletableSelection = selectedIds.filter((id) => id !== rootId && committedNodeIds.has(id));
  const historyLength = canonical?.history_length
    ?? [...(canonical?.operations ?? [])].reverse()
      .find((operation) => Array.isArray(operation.history_entry_ids))?.history_entry_ids?.length
    ?? 0;
  const canRedo = (canonical?.history_cursor ?? 0) < historyLength;

  const withGhostProposal = (action) => (ghostId) => {
    const ghost = ghostVisuals.ghostNodes.find((node) => node.id === ghostId);
    const proposal = pendingProposals.find((candidate) => candidate.id === ghost?.proposalId);
    if (proposal) action(proposal);
  };

  const focusSearchResult = (id) => {
    rememberView();
    selectOne(id);
    updateView({ focusId: id, drawerOpen: false });
    centerOnNode(id);
  };
  const exploreProposal = (proposal) => {
    const ghost = ghostVisuals.ghostNodes.find((node) => node.proposalId === proposal.id);
    if (ghost) return askAboutBubble(ghost.id);
    updateView({ drawerTab: "conversation" });
    setChatValue(`Let’s explore this suggestion without changing the map: ${proposal.rationale}`);
    window.setTimeout(() => chatInputRef.current?.focus(), 50);
  };
  const exportSession = (format) => runCommand(() => downloadSessionExport(canonical.id, format));

  return (
    <main className={`app-shell paper session-shell canonical-session-shell ${drawerOpen ? "has-workspace-drawer" : ""}`} style={{ "--session-drawer-width": `${drawerWidth}px` }}>
      <audio ref={audioRef} autoPlay playsInline className="session-audio" />
      <MindMap
        concept="paper"
        nodes={mapNodes}
        edges={mapEdges}
        selectedId={selectedId}
        selectedIds={selectedIds}
        onSelect={selectOne}
        onSelectMany={(ids) => {
          const committedIds = new Set(nodesRef.current.map((node) => node.id));
          const filtered = ids.filter((id) => committedIds.has(id));
          updateView({ selectedIds: filtered });
        }}
        onMoveStart={graph.startMoveNode}
        onMoveNode={graph.moveNode}
        onMoveEnd={finishMoveNode}
        onMoveCancel={graph.cancelMoveNode}
        onEdit={(id) => editor.openEdit(nodesRef.current.find((node) => node.id === id))}
        onAdd={(parentId) => editor.openNew({ parentId })}
        onAskAI={askAboutBubble}
        controlsHidden={Boolean(composer)}
        onPin={(id) => command({ type: "set_node_pinned", node_id: id, pinned: !nodesRef.current.find((node) => node.id === id)?.pinned })}
        onPark={(id) => command({ type: "set_node_parked", node_id: id, parked: !nodesRef.current.find((node) => node.id === id)?.parked })}
        onSources={(id) => { rememberView(); selectOne(id); updateView({ drawerTab: "sources", drawerOpen: true }); }}
        onArmConnect={armConnection}
        onCancelConnect={cancelConnection}
        onConnect={(sourceId, targetId) => connectTarget(targetId, sourceId)}
        actionsNodeId={bubbleActionsId}
        onActionsChange={setBubbleActionsId}
        rootId={rootId}
        onSpawnFreeform={editor.spawnFreeform}
        onDelete={deleteBubble}
        onAcceptGhost={withGhostProposal(acceptProposal)}
        onDismissGhost={withGhostProposal(dismissProposal)}
        onRemoveConnection={(edge, motion) => graph.removeConnection(canonicalRef.current, edge, motion, perform, showToast)}
        connectFromId={connectFromId}
        zoom={zoom}
        setZoom={setZoom}
        pan={pan}
        setPan={setPan}
        showSuggestions={showSuggestions}
        showProvenance={showProvenance}
        focusId={focusId}
        reducedMotion={reducedMotion}
        marqueeActive={marqueeActive}
        lassoActive={selectionMode === "lasso"}
        connectionPopQueueRef={connectionPopQueueRef}
      />

      {!nodes.length && !loading && !composer && (
        <div className="session-empty" aria-hidden="true">
          <IconSparkles />
          <p>Say what you're thinking.</p>
          <small>Double-click the canvas to add a thought, or start talking.</small>
        </div>
      )}
      {loading && <div className="session-loading" role="status">Opening your map…</div>}

      <header className="session-identity" aria-label="Current map">
        {renameId === canonical?.id ? (
          <form onSubmit={saveRename}>
            <input aria-label="Map name" autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setRenameId(null); }} />
            <IconButton type="submit" label="Save map name" disabled={!renameValue.trim()}><IconCheck /></IconButton>
            <IconButton label="Cancel rename" onClick={() => setRenameId(null)}><IconX /></IconButton>
          </form>
        ) : <button type="button" className="session-title" title="Rename map" onClick={() => { if (canonical) { setRenameId(canonical.id); setRenameValue(canonical.title); } }}><span>{canonical?.title ?? "Opening map…"}</span><IconPencil /></button>}
        <small className={!syncConnected ? "is-disconnected" : ""} role="status">{!canonical ? "Opening your map…" : !syncConnected ? "Reconnecting to local save…" : pendingWrites || busy || preferenceBusy || synthesizing ? "Saving…" : "Saved on this device"}</small>
      </header>

      <WorkspaceRail drawerOpen={drawerOpen} drawerTab={drawerTab} openDrawer={openDrawer} focusId={focusId} toggleFocus={toggleFocus} />

      <div className="top-dock" aria-label="Canvas modes">
        <IconButton label="New thought" onClick={openNewThought} disabled={composerSaving} testId="new-thought-tool"><IconPlus /></IconButton>
        <SelectionTools selectionMode={selectionMode} onChange={(mode) => { updateView({ selectionMode: mode, selectedIds: [] }); }} />
        <IconButton label={`${pendingProposals.length} proposals waiting`} active={drawerOpen && drawerTab === "proposals"} onClick={() => openDrawer("proposals")} testId="ai-tool"><IconSparkles />{pendingProposals.length > 0 && <i className="tool-pip">{pendingProposals.length}</i>}</IconButton>
        <IconButton label="Switch graph view" active={drawerOpen && drawerTab === "layouts"} onClick={() => openDrawer("layouts")} testId="layout-tool"><IconAffiliate /></IconButton>
        <IconButton label="Map overview and synthesis" active={drawerOpen && drawerTab === "overview"} onClick={() => openDrawer("overview")} testId="overview-tool"><IconGridDots /></IconButton>
        <IconButton label="Layers" active={drawerOpen && drawerTab === "layers"} onClick={() => openDrawer("layers")} testId="layers-tool"><IconStack2 /></IconButton>
      </div>

      {marqueeActive && selectedIds.length > 0 && (
        <div className="selection-toolbar" role="toolbar" aria-label="Selection actions" data-testid="selection-toolbar">
          <span>{selectedIds.length} selected{selectedIds.includes(rootId) ? " · starting thought protected" : ""}</span>
          <IconButton label={`Delete ${deletableSelection.length} selected thoughts`} disabled={!deletableSelection.length} onClick={deleteSelected} className="danger-action" testId="delete-selection"><IconTrash /></IconButton>
        </div>
      )}

      <WorkspaceDrawer
        drawer={{ drawerOpen, drawerTab, drawerWidth, setDrawerOpen: (drawerOpen) => updateView({ drawerOpen }), setDrawerTab: (drawerTab) => updateView({ drawerTab }), setDrawerWidth }}
        session={canonical}
        conversation={{ conversationTimeline, highlight, utteranceElementsRef, transcriptEndRef, chatInputRef, chatValue, setChatValue, busy, submitChat, openEvidence }}
        library={library}
        map={{ nodes, selected, viewMode, changeView, searchQuery, setSearchQuery, searchResults, focusSearchResult }}
        proposals={{ pendingProposals, acceptProposal, dismissProposal, excludeProposalOperation, exploreProposal }}
        preferences={{ showSuggestions, setShowSuggestions: (showSuggestions) => updateView({ showSuggestions }), showProvenance, setShowProvenance, reducedMotion, setReducedMotion, partnerMode, mappingPaused, preferenceBusy, setPreferences }}
        synthesis={{ synthesis, synthesizing, requestSynthesis, exportSession }}
        history={{ undo, redo, undoLabel, canRedo }}
      />

      {selected && !marqueeActive && !composer && <div className="session-selection-context" data-testid="selection-context">
        <div className="session-selection-label"><small>{selected.ghost ? "Suggestion" : selectedCanonical?.parked ? "Kept aside" : "Selected thought"}</small><strong title={nodeLabel(selected)}>{nodeLabel(selected)}</strong></div>
        <div className="session-context-actions">
          {!selected.ghost && <IconButton label="New connected thought" onClick={() => editor.openNew({ parentId: selected.id })} testId="add-connected-thought"><IconPlus /></IconButton>}
          {!selected.ghost && <IconButton label="More thought actions" testId="thought-more-actions" onClick={() => setBubbleActionsId((current) => current === selected.id ? null : selected.id)}><IconDots /></IconButton>}
          {selected.ghost && <IconButton label="Explore suggestion" onClick={() => askAboutBubble(selected.id)}><IconMessageCircle /></IconButton>}
          {selectedProposal && <IconButton label="Review suggestion" onClick={() => { updateView({ drawerTab: "proposals", drawerOpen: true }); }}><IconSparkles /></IconButton>}
          <IconButton label="Clear selection" onClick={() => selectOne(null)}><IconX /></IconButton>
        </div>
      </div>}

      {showSuggestions && pendingProposals.length > 0 && !(drawerOpen && drawerTab === "proposals") && <button type="button" className="session-suggestion-nudge" onClick={() => { updateView({ drawerTab: "proposals", drawerOpen: true }); }}><IconSparkles /><span>{pendingProposals.length === 1 ? "A new angle to consider" : `${pendingProposals.length} suggestions to consider`}</span></button>}

      {recentChange && <div className="session-recent-change" role="status"><span>{recentChange.label}</span><button type="button" onClick={() => { rememberView(); const id = recentChange.nodeIds.find((candidate) => canonical.nodes.some((node) => node.id === candidate)); if (id) { selectOne(id); updateView({ focusId: id }); centerOnNode(id); } else { updateView({ drawerTab: "activity", drawerOpen: true }); } }}>Show</button><IconButton label={undoLabel} onClick={undo} disabled={!canonical?.history_cursor}><IconArrowBackUp /></IconButton><IconButton label="Dismiss recent change" onClick={() => setRecentChange(null)}><IconX /></IconButton></div>}

      <ThoughtEditor composer={composer} value={composerValue} saving={composerSaving}
        parentLabel={nodeLabel(nodes.find((node) => node.id === composer?.parentId) ?? { lines: ["selected thought"] })}
        onChange={editor.setValue} onSubmit={editor.submit} onClose={editor.close} />

      <VoiceControls voice={voice}
        preferences={{ partnerMode, mappingPaused, preferenceBusy, setPreferences }}
        controller={{ controllerStatus, controllerRetrying, retryMapController }} />

      <div className="zoom-controls" aria-label="Canvas zoom"><IconButton label="Back to previous view" disabled={!canGoBack} onClick={restorePreviousView}><IconArrowLeft /></IconButton><IconButton label={undoLabel} onClick={undo} disabled={!canonical?.history_cursor}><IconArrowBackUp /></IconButton><IconButton label="Center map" onClick={() => { rememberView(); updateView({ pan: { x: 0, y: 0 }, zoom: 1, focusId: null }); }}><IconFocusCentered /></IconButton><IconButton label="Zoom out" onClick={() => setZoom((value) => clamp(value - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))}><IconMinus /></IconButton><span>{Math.round(zoom * 100)}%</span><IconButton label="Zoom in" onClick={() => setZoom((value) => clamp(value + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))}><IconPlus /></IconButton></div>
      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </main>
  );
}
