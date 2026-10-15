import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  IconAffiliate,
  IconArrowBackUp,
  IconArrowLeft,
  IconDownload,
  IconDots,
  IconMicrophoneOff,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconArrowForwardUp,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconEye,
  IconFocusCentered,
  IconGridDots,
  IconHierarchy2,
  IconMap2,
  IconMarquee,
  IconLasso,
  IconLink,
  IconMessageCircle,
  IconMicrophone,
  IconMinus,
  IconPencil,
  IconPlus,
  IconQuote,
  IconSearch,
  IconSend,
  IconSettings,
  IconSparkles,
  IconStack2,
  IconStar,
  IconTrash,
  IconUser,
  IconX,
} from "@tabler/icons-react";
import { IconButton, MindMap, layoutHierarchy } from "./App.jsx";
import { canConnect } from "./connectionGesture.js";
import { BASE_HEIGHT, BASE_WIDTH } from "./mapData.js";
import {
  FLUID_PHYSICS_SETTINGS,
  captureFluidRestLengths,
  stepFluidPhysics,
} from "./fluidPhysics.js";
import { clamp, withWobble } from "./fluidMaterial.js";
import {
  applyConnectionGrowthMotion,
  buildConnectionPopTransition,
  connectionEdgeKey,
  connectionEndpointKey,
  connectionMatches,
  confirmPendingConnectionEdge,
} from "./session/connectionMotion.js";
import {
  actorLabel,
  activityLabel,
  buildConversationTimeline,
  createMapControllerActivityDelay,
  mapControllerPresentation,
  proposalOperationLabel,
  proposalVisuals,
  visualizeSession,
} from "./session/presentation.js";
import { SessionApiError, shouldApplySessionSnapshot } from "./sessionApi.js";
import { createSessionLiveClient } from "./sessionLive.js";
import { liveWorkspaceClient } from "./workspaceClient.js";
import { createChatSubmission } from "./chatSubmission.js";
import { suggestionDisplayText } from "../shared/presentationText.mjs";
import { readWorkspaceState, writeWorkspaceState, recentMapChange, latestUndoLabel, groupUtterancesByPause, WORKSPACE_CAMERA_VERSION } from "./workspaceUi.js";
import {
  MIN_CAMERA_ZOOM, MAX_CAMERA_ZOOM, DEFAULT_CAMERA_ZOOM, cameraTransform, cameraCenteredOn,
  zoomCameraAt, initialMapCamera, fitMapCamera, revealNodeCamera,
} from "./mapCamera.js";

const bootstrapPromises = new WeakMap();

function RailButton({ label, children, active = false, pressed, expanded, onClick, testId, className = "" }) {
  return (
    <div className={`session-rail-item ${active ? "is-current" : ""}`}>
      <button type="button" className={`icon-button ${active ? "is-active" : ""} ${className}`}
        aria-label={label} aria-pressed={pressed} aria-expanded={expanded}
        onClick={onClick} data-testid={testId}>
        {children}
      </button>
      <span className="session-rail-tooltip" aria-hidden="true">{label}</span>
    </div>
  );
}

function snapshotFrom(value) {
  return value?.snapshot ?? value?.session ?? (value?.id && value?.schema_version ? value : null);
}

function listPayload(value) {
  if (Array.isArray(value)) return { sessions: value, activeSessionId: value[0]?.id ?? null };
  return {
    sessions: value?.sessions ?? [],
    activeSessionId: value?.active_session_id ?? value?.activeSessionId ?? null,
  };
}

async function bootstrapCanonicalSession(client) {
  if (!bootstrapPromises.has(client)) {
    const { listSessions, createSession, getSession } = client;
    const promise = (async () => {
      if (client.bootstrap) {
        const result = await client.bootstrap();
        return { ...result, listed: listPayload(result.listed) };
      }
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
      bootstrapPromises.delete(client);
      throw error;
    });
    bootstrapPromises.set(client, promise);
  }
  return bootstrapPromises.get(client);
}

function formatClock(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function formatUpdated(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) return "Recently";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function nodeLabel(node) {
  return node?.text ?? node?.lines?.join(" ") ?? "Thought";
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

export function CanonicalSessionApp({ client = liveWorkspaceClient }) {
  const {
    applySessionOperation, createSession, deleteSession, getSession, listSessions, renameSession,
    retrySessionMapController, subscribeSessionEvents, synthesizeSession, updateSessionUiContext,
    sendSessionChat, retryLiveCapture, updateWorkspacePreferences, downloadSessionExport,
  } = client;
  const example = client.example === true;
  const [canonical, setCanonical] = useState(null);
  const canonicalRef = useRef(null);
  const sessionIdRef = useRef(null);
  const committedPositionsRef = useRef(new Map());
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saveFailure, setSaveFailure] = useState("");

  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const organicPositionsRef = useRef(new Map());
  const connectionPopQueueRef = useRef([]);
  const manualPopKeysRef = useRef(new Set());
  const pendingManualConnectionsRef = useRef(new Map());
  const [proposalPositions, setProposalPositions] = useState(() => new Map());
  const proposalNodesRef = useRef([]);
  const proposalEdgesRef = useRef([]);
  const proposalDragStartRef = useRef(new Map());

  const [selectedId, setSelectedId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [connectFromId, setConnectFromId] = useState(null);
  const [bubbleActionsId, setBubbleActionsId] = useState(null);
  const armConnection = useCallback((id) => setConnectFromId((current) => current === id ? null : id), []);
  const cancelConnection = useCallback(() => setConnectFromId(null), []);
  const [zoom, setZoom] = useState(DEFAULT_CAMERA_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const shellRef = useRef(null);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const cameraRef = useRef({ zoom, pan });
  cameraRef.current = { zoom, pan };
  const initialCameraRef = useRef(false);
  const awaitingFirstContentRef = useRef(false);
  const skipCameraRevealRef = useRef(false);
  const previousViewportRef = useRef(viewport);
  const [cameraRevealRequest, setCameraRevealRequest] = useState(0);
  const previousRevealRequestRef = useRef(0);
  const panCanvas = useCallback((value) => { awaitingFirstContentRef.current = false; setPan(value); }, []);
  const zoomCanvas = useCallback((value) => { awaitingFirstContentRef.current = false; setZoom(value); }, []);
  const [viewMode, setViewMode] = useState("clusters");
  const [focusId, setFocusId] = useState(null);
  const [selectionMode, setSelectionMode] = useState(null);
  const marqueeActive = selectionMode !== null;
  const [selectionPickerOpen, setSelectionPickerOpen] = useState(false);
  const selectionPickerRef = useRef(null);

  useEffect(() => {
    if (!selectionPickerOpen) return;
    const picker = selectionPickerRef.current;
    picker?.querySelector('[data-selection-option]')?.focus();
    const dismiss = (event) => {
      if (!picker?.contains(event.target)) setSelectionPickerOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [selectionPickerOpen]);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(360);
  const workspaceRestoredRef = useRef(null);
  const workspaceStateRef = useRef(null);
  const [previousViews, setPreviousViews] = useState([]);
  const [recentChange, setRecentChange] = useState(null);
  const [pendingWrites, setPendingWrites] = useState(0);
  const [syncConnected, setSyncConnected] = useState(true);
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [mutePending, setMutePending] = useState(false);
  const [backendState, setBackendState] = useState("idle");
  const [drawerTab, setDrawerTab] = useState("conversation");
  const [searchQuery, setSearchQuery] = useState("");
  const [favorite, setFavorite] = useState(true);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const showSuggestionsRef = useRef(showSuggestions);
  showSuggestionsRef.current = showSuggestions;
  const [showProvenance, setShowProvenance] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => (
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false
  ));
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const [chatValue, setChatValue] = useState("");
  const [chatFailure, setChatFailure] = useState(null);
  const [chatSubmissions] = useState(() => createChatSubmission());
  const [captureRetrying, setCaptureRetrying] = useState(false);
  const [composer, setComposer] = useState(null);
  const [composerValue, setComposerValue] = useState("");
  const [composerSaving, setComposerSaving] = useState(false);
  const composerSubmissionRef = useRef(false);
  const editorReturnFocusRef = useRef(null);
  const editorWasOpenRef = useRef(false);
  const [highlight, setHighlight] = useState(null);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [synthesis, setSynthesis] = useState("");
  const [synthesizing, setSynthesizing] = useState(false);
  const [renameId, setRenameId] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  const [voiceState, setVoiceState] = useState("idle");
  const [voiceError, setVoiceError] = useState("");
  const [controllerActivity, setControllerActivity] = useState({
    sessionId: null,
    active: false,
    visible: false,
  });
  const [controllerRetrying, setControllerRetrying] = useState(false);
  const [liveCaption, setLiveCaption] = useState("");
  const [partnerCaption, setPartnerCaption] = useState("");
  const [seconds, setSeconds] = useState(0);
  const controllerActivityDelayRef = useRef(null);
  const realtimeRef = useRef(null);
  const audioRef = useRef(null);

  const utteranceElementsRef = useRef(new Map());
  const transcriptEndRef = useRef(null);
  const chatInputRef = useRef(null);

  const showToast = useCallback((message) => setToast(message), []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

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

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return undefined;
    const measure = () => {
      const { width, height } = shell.getBoundingClientRect();
      setViewport((current) => current.width === width && current.height === height ? current : { width, height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    measure();
    return () => observer.disconnect();
  }, []);

  // Measure the visible chrome, so camera framing and CSS share the same space.
  const availableCanvasRect = useCallback(({ ignoreDrawer = false, ignoreComposer = false } = {}) => {
    const shell = shellRef.current;
    const bounds = shell?.getBoundingClientRect() ?? { left: 0, top: 0, ...viewport };
    const railWidth = shell ? parseFloat(getComputedStyle(shell).getPropertyValue("--workspace-rail-width")) || 60 : 60;
    const rect = { left: railWidth + 16, top: 100, right: bounds.width - 20, bottom: bounds.height - 24 };
    const visibleBounds = (selector) => {
      const element = shell?.querySelector(selector);
      if (!element?.getClientRects().length) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left - bounds.left, right: box.right - bounds.left, top: box.top - bounds.top, bottom: box.bottom - bounds.top };
    };
    for (const selector of [".session-identity", ".top-dock", ".session-selection-context"]) {
      const box = visibleBounds(selector);
      if (box) rect.top = Math.max(rect.top, box.bottom + 16);
    }
    for (const selector of [".zoom-controls", ".session-conversation-controls"]) {
      const box = visibleBounds(selector);
      if (box) rect.bottom = Math.min(rect.bottom, box.top - 20);
    }
    const drawer = !ignoreDrawer && visibleBounds(".session-drawer");
    if (drawer) {
      if (bounds.width <= 760) rect.bottom = Math.min(rect.bottom, drawer.top - 16);
      else rect.left = Math.max(rect.left, drawer.right + 20);
    }
    const editor = !ignoreComposer && visibleBounds(".session-composer");
    if (editor) rect.bottom = Math.min(rect.bottom, editor.top - 16);
    return { ...rect, right: Math.max(rect.left + 40, rect.right), bottom: Math.max(rect.top + 40, rect.bottom) };
  }, [viewport]);

  const applyCamera = useCallback((camera) => {
    cameraRef.current = camera;
    setZoom(camera.zoom);
    setPan(camera.pan);
  }, []);

  const openThoughtEditor = (next, value = "") => {
    if (composerSubmissionRef.current) return;
    editorReturnFocusRef.current = {
      element: document.activeElement,
      selector: next.parentId ? '[data-testid="add-connected-thought"]'
        : next.mode === "edit" && !next.fresh ? '[data-testid="thought-more-actions"]'
          : '[data-testid="new-thought-tool"]',
    };
    setComposer(next);
    setComposerValue(value);
  };

  useLayoutEffect(() => {
    const closed = editorWasOpenRef.current && !composer;
    editorWasOpenRef.current = Boolean(composer);
    if (!closed || !editorReturnFocusRef.current) return undefined;
    const target = editorReturnFocusRef.current;
    editorReturnFocusRef.current = null;
    const frame = requestAnimationFrame(() => {
      const element = target.element?.isConnected && target.element !== document.body ? target.element
        : shellRef.current?.querySelector(target.selector);
      element?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [composer]);

  const restoreWorkspace = useCallback((snapshot) => {
    const saved = readWorkspaceState(snapshot.id);
    const ids = new Set(snapshot.nodes.map((node) => node.id));
    initialCameraRef.current = saved.camera_version !== WORKSPACE_CAMERA_VERSION
      || (saved.camera_viewport_width <= 760) !== (window.innerWidth <= 760);
    awaitingFirstContentRef.current = snapshot.nodes.length === 0;
    setPan(saved.pan);
    setZoom(saved.zoom);
    setViewMode(saved.view_mode);
    setFocusId(ids.has(saved.focus_id) ? saved.focus_id : null);
    const selection = saved.selected_node_ids.filter((id) => ids.has(id));
    setSelectedIds(selection);
    setSelectedId(selection.length === 1 ? selection[0] : null);
    setDrawerTab(saved.drawer_tab);
    setDrawerOpen(saved.drawer_open);
    setDrawerWidth(saved.drawer_width);
    setShowSuggestions(saved.show_suggestions);
    setPreviousViews([]);
    setRecentChange(null);
    workspaceRestoredRef.current = snapshot.id;
  }, []);

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
    if (!switching && animateNew && changed) setRecentChange(changed);
    const motionEnabled = animateNew && !reducedMotionRef.current;
    const visual = visualizeSession(
      snapshot,
      nodesRef.current,
      edgesRef.current,
      committedPositionsRef.current,
      undefined,
      { animateNew: motionEnabled },
    );
    let nextNodes = visual.nodes;
    visual.addedEdges.forEach((edge) => {
      const pendingKey = connectionEndpointKey(edge);
      const pendingManual = pendingManualConnectionsRef.current.get(pendingKey);
      if (pendingManual) {
        Object.assign(edge, confirmPendingConnectionEdge(edge, pendingManual));
        pendingManualConnectionsRef.current.delete(pendingKey);
        return;
      }
      if (motionEnabled) {
        nextNodes = applyConnectionGrowthMotion(nextNodes, edge);
      }
    });

    const confirmedEndpointKeys = new Set(visual.edges.map(connectionEndpointKey));
    pendingManualConnectionsRef.current.forEach((pending, key) => {
      if (!confirmedEndpointKeys.has(key)) visual.edges.push(pending.edge);
    });

    if (motionEnabled) {
      const nextNodeIds = new Set(nextNodes.map((node) => node.id));
      let transitionNodes = [
        ...nextNodes,
        ...nodesRef.current.filter((node) => !node.ghost && !nextNodeIds.has(node.id)),
      ];
      visual.removedEdges.forEach((edge) => {
        if (edge.pending) return;
        const key = connectionEdgeKey(edge);
        const wasManual = manualPopKeysRef.current.delete(key);
        const alreadyPopping = connectionPopQueueRef.current.some((pop) => (
          performance.now() < pop.start + pop.duration
          && connectionMatches(edge, {
            id: pop.edgeId,
            from: pop.aId,
            to: pop.bId,
          })
        ));
        if (wasManual || alreadyPopping) return;
        const transition = buildConnectionPopTransition(transitionNodes, edge, {}, {
          eventId: `canonical:${snapshot.revision}:${key}`,
        });
        transitionNodes = transition.nodes;
        if (transition.pop) connectionPopQueueRef.current.push(transition.pop);
      });
      const transitionedById = new Map(transitionNodes.map((node) => [node.id, node]));
      nextNodes = nextNodes.map((node) => transitionedById.get(node.id) ?? node);
    } else {
      visual.removedEdges.forEach((edge) => {
        if (!edge.pending) manualPopKeysRef.current.delete(connectionEdgeKey(edge));
      });
    }

    const nextEdges = captureFluidRestLengths(nextNodes, visual.edges, {});
    canonicalRef.current = snapshot;
    sessionIdRef.current = snapshot.id;
    committedPositionsRef.current = visual.committedPositions;
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setCanonical(snapshot);
    setSynthesis(snapshot.synthesis?.text ?? "");
    setNodes(nextNodes);
    setEdges(nextEdges);
    setSessions((current) => {
      const next = current.filter((item) => item.id !== snapshot.id);
      return [summaryFromSession(snapshot), ...next];
    });
    setSelectedIds((current) => {
      const next = current.filter((id) => snapshot.nodes.some((node) => node.id === id)
        || proposalNodesRef.current.some((node) => node.id === id && (snapshot.proposals ?? []).some((proposal) => proposal.id === node.proposalId && proposal.status === "pending")));
      return next.length === current.length ? current : next;
    });
    setSelectedId((current) => {
      const ghost = proposalNodesRef.current.find((node) => node.id === current);
      return current && (snapshot.nodes.some((node) => node.id === current)
        || (snapshot.proposals ?? []).some((proposal) => proposal.id === ghost?.proposalId && proposal.status === "pending")) ? current : null;
    });
    if (switching) restoreWorkspace(snapshot);
  }, [restoreWorkspace]);

  const stopRealtime = useCallback(() => {
    realtimeRef.current?.disconnect();
    realtimeRef.current = null;
    setVoiceState("idle");
    setLiveCaption("");
    setPartnerCaption("");
    setSeconds(0);
    setMuted(false);
    setBackendState("idle");
  }, []);

  const refreshSessions = useCallback(async () => {
    const payload = listPayload(await listSessions());
    setSessions(payload.sessions);
    return payload;
  }, []);

  const openSession = useCallback(async (id) => {
    if (!id) return;
    if (sessionIdRef.current) writeWorkspaceState(sessionIdRef.current, workspaceStateRef.current);
    stopRealtime();
    setLoading(true);
    setSaveFailure("");
    setChatFailure(null);
    setChatValue("");
    try {
      const snapshot = snapshotFrom(await getSession(id));
      committedPositionsRef.current = new Map();
      connectionPopQueueRef.current = [];
      manualPopKeysRef.current.clear();
      pendingManualConnectionsRef.current.clear();
      nodesRef.current = [];
      edgesRef.current = [];
      setSelectedId(null);
      setSelectedIds([]);
      setFocusId(null);
      setConnectFromId(null);
      editorReturnFocusRef.current = null;
      setComposer(null);
      setComposerValue("");
      setSelectionMode(null);
      setHighlight(null);
      setViewMode("clusters");
      organicPositionsRef.current = new Map();
      setPan({ x: 0, y: 0 });
      setZoom(DEFAULT_CAMERA_ZOOM);
      setSynthesis("");
      setSynthesizing(false);
      applyCanonicalSnapshot(snapshot, { animateNew: false, allowSessionSwitch: true });
      await refreshSessions();
    } catch (error) {
      showToast(error.message);
    } finally {
      setLoading(false);
    }
  }, [applyCanonicalSnapshot, refreshSessions, showToast, stopRealtime]);

  useEffect(() => {
    let cancelled = false;
    bootstrapCanonicalSession(client)
      .then(({ listed, snapshot }) => {
        if (cancelled) return;
        setSessions(listed.sessions);
        applyCanonicalSnapshot(snapshot, { animateNew: false });
        setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoading(false);
        setLoadError(error.message);
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
      setSaveFailure("");
      if (result?.warnings?.length) showToast(result.warnings.map(suggestionDisplayText).join(" · "));
      return result;
    } catch (error) {
      if (error instanceof SessionApiError && error.snapshot) applyCanonicalSnapshot(error.snapshot);
      setSaveFailure(error.message);
      throw error;
    } finally {
      setPendingWrites((value) => Math.max(0, value - 1));
    }
  }, [applyCanonicalSnapshot, showToast]);

  useEffect(() => {
    let animationFrame;
    let lastTime = performance.now();
    const animate = (now) => {
      const frameStep = clamp((now - lastTime) / 16.67, 0.35, 2);
      lastTime = now;
      const presentationNodes = showSuggestionsRef.current
        ? [...nodesRef.current, ...proposalNodesRef.current]
        : nodesRef.current;
      const presentationEdges = showSuggestionsRef.current
        ? [...edgesRef.current, ...proposalEdgesRef.current]
        : edgesRef.current;
      const result = viewMode === "clusters"
        ? stepFluidPhysics(presentationNodes, presentationEdges, {
            frameStep,
            width: BASE_WIDTH,
            height: BASE_HEIGHT,
            settings: FLUID_PHYSICS_SETTINGS,
            includeGhosts: true,
          })
        : { nodes: presentationNodes, active: false };
      if (result.active) {
        const nextNodes = result.nodes.filter((node) => !node.ghost);
        const nextProposalNodes = result.nodes.filter((node) => node.ghost);
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        if (showSuggestionsRef.current) {
          proposalNodesRef.current = nextProposalNodes;
          setProposalPositions(new Map(nextProposalNodes.map((node) => [node.id, node])));
        }
      }
      animationFrame = window.requestAnimationFrame(animate);
    };
    animationFrame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [reducedMotion, viewMode]);

  useEffect(() => {
    if (viewMode !== "hierarchy" || !canonical?.id) return;
    const next = layoutHierarchy(nodesRef.current, edgesRef.current);
    nodesRef.current = next;
    setNodes(next);
  }, [canonical?.id, canonical?.nodes?.length, canonical?.edges?.length, viewMode]);

  useEffect(() => {
    if (!realtimeRef.current?.connected) return undefined;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [voiceState]);

  useEffect(() => {
    if (!canonical?.id) return undefined;
    const timer = window.setTimeout(() => {
      const ghost = proposalNodesRef.current.find((node) => node.id === selectedId);
      const committedIds = new Set(canonicalRef.current?.nodes.map((node) => node.id));
      const committedSelection = selectedIds.filter((id) => committedIds.has(id));
      updateSessionUiContext(canonical.id, {
        selected_node_ids: committedSelection,
        selected_proposal_id: ghost?.proposalId ?? null,
        focus_id: focusId,
        view_mode: viewMode,
      }).catch(() => {});
      realtimeRef.current?.updateContext({
        selectedNodeIds: committedSelection,
        selectedProposalId: ghost?.proposalId ?? null,
        selectedText: ghost ? nodeLabel(ghost) : nodesRef.current.filter((node) => committedSelection.includes(node.id)).map(nodeLabel).join("; "),
      })?.catch?.(() => {});
    }, 150);
    return () => window.clearTimeout(timer);
  }, [canonical?.id, focusId, selectedId, selectedIds, viewMode]);

  workspaceStateRef.current = { pan, zoom, camera_version: WORKSPACE_CAMERA_VERSION, camera_viewport_width: viewport.width, selected_node_ids: selectedIds, focus_id: focusId, view_mode: viewMode, drawer_tab: drawerTab, drawer_open: drawerOpen, drawer_width: drawerWidth, show_suggestions: showSuggestions };
  useEffect(() => {
    if (!canonical?.id || workspaceRestoredRef.current !== canonical.id || initialCameraRef.current) return undefined;
    const sessionId = canonical.id;
    const timer = window.setTimeout(() => writeWorkspaceState(sessionId, workspaceStateRef.current), 500);
    const flush = () => writeWorkspaceState(sessionId, workspaceStateRef.current);
    window.addEventListener("pagehide", flush);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
    };
  }, [canonical?.id, pan, zoom, viewport.width, selectedIds, focusId, viewMode, drawerTab, drawerOpen, drawerWidth, showSuggestions]);

  useEffect(() => {
    if (!recentChange) return undefined;
    const timer = window.setTimeout(() => setRecentChange(null), 12000);
    return () => window.clearTimeout(timer);
  }, [recentChange]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [canonical?.transcript?.length]);

  useEffect(() => () => stopRealtime(), [stopRealtime]);

  const selectOne = useCallback((id) => {
    setSelectedId(id);
    setSelectedIds(id ? [id] : []);
    setBubbleActionsId(null);
  }, []);

  const touchGraph = (nextNodes, nextEdges = edgesRef.current) => {
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
  };

  const sendConversation = async (text, options) => {
    const targetSessionId = sessionIdRef.current;
    const client = realtimeRef.current;
    if (!targetSessionId) throw new Error("Open a map before starting a conversation");
    const ghost = proposalNodesRef.current.find((node) => node.id === selectedId);
    await updateSessionUiContext(targetSessionId, {
      selected_node_ids: selectedIds.filter((id) => canonicalRef.current.nodes.some((node) => node.id === id)),
      selected_proposal_id: ghost?.proposalId ?? null,
      focus_id: focusId,
      view_mode: viewMode,
    });
    const result = client?.connected
      ? await client.sendText(text, options)
      : await sendSessionChat(targetSessionId, text, options);
    const snapshot = snapshotFrom(result);
    if (snapshot) applyCanonicalSnapshot(snapshot);
    return result;
  };

  const submitChat = async (event) => {
    event.preventDefault();
    const text = chatValue.trim();
    if (!text || busy) return;
    const submittedSessionId = sessionIdRef.current;
    setChatValue("");
    setChatFailure(null);
    setBusy(true);
    try {
      await chatSubmissions.send(submittedSessionId, text, sendConversation);
    } catch (error) {
      if (sessionIdRef.current === submittedSessionId) {
        if (error.snapshot) applyCanonicalSnapshot(error.snapshot);
        setChatValue((current) => current || text);
        setChatFailure({ sessionId: submittedSessionId, message: error.code === "chat_already_attempted"
          ? "Your message is saved. This request may already have changed the map; review it before sending a new request."
          : error.details?.error?.message_saved
          ? "Your message is saved. Send again to retry Partner’s response."
          : "Your draft is kept below. Send again to retry." });
      }
      showToast(error.message);
    } finally {
      setBusy(false);
    }
  };

  const buildRealtime = () => createSessionLiveClient({
    sessionId: sessionIdRef.current,
    audioElement: audioRef.current,
    getSelectedContext: () => ({
      selectedNodeIds: (workspaceStateRef.current?.selected_node_ids ?? []).filter((id) => nodesRef.current.some((node) => node.id === id)),
      selectedProposalId: proposalNodesRef.current.find((node) => workspaceStateRef.current?.selected_node_ids?.includes(node.id))?.proposalId ?? null,
      selectedText: nodesRef.current.filter((node) => workspaceStateRef.current?.selected_node_ids?.includes(node.id)).map(nodeLabel).join("; "),
    }),
    onStateChange: ({ state }) => {
      setVoiceState(state);
      if (state === "connected") setVoiceError("");
    },
    onUserTranscriptPartial: ({ text }) => setLiveCaption(text),
    onPartnerTranscriptPartial: ({ text }) => setPartnerCaption(text),
    onSnapshot: applyCanonicalSnapshot,
    onBackendStatus: ({ state }) => setBackendState(state),
    onMutedChange: ({ muted: nextMuted, pending }) => { setMuted(nextMuted); setMutePending(Boolean(pending)); },
    onError: (error) => setVoiceError(error.message),
  });

  const startVoice = async () => {
    if (!canonical?.id || realtimeRef.current?.connected) return;
    setVoiceError("");
    setSeconds(0);
    const realtime = buildRealtime();
    realtimeRef.current = realtime;
    try {
      await realtime.connect();
    } catch (error) {
      realtimeRef.current = null;
      setVoiceError(error.message);
    }
  };

  const endVoice = async () => {
    try { await realtimeRef.current?.end(); }
    catch (error) { setVoiceError(error.message); }
    finally { stopRealtime(); }
  };

  const toggleMute = async () => {
    try { await realtimeRef.current?.setMuted(!muted); }
    catch (error) { setVoiceError(error.message); }
  };

  const retryCapture = async () => {
    const id = sessionIdRef.current;
    if (!id || captureRetrying) return;
    setCaptureRetrying(true);
    try {
      const result = await retryLiveCapture(id);
      if (sessionIdRef.current === id) applyCanonicalSnapshot(snapshotFrom(result));
    } catch (error) { showToast(error.message); }
    finally { setCaptureRetrying(false); }
  };

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

  const startMoveNode = (id) => {
    const proposalNode = proposalNodesRef.current.find((node) => node.id === id);
    if (proposalNode) {
      proposalDragStartRef.current.set(id, proposalNode);
      const next = proposalNodesRef.current.map((node) => node.id === id
        ? { ...node, dragging: true, vx: 0, vy: 0, shadeVx: 0, shadeVy: 0 }
        : node);
      proposalNodesRef.current = next;
      setProposalPositions(new Map(next.map((node) => [node.id, node])));
      return;
    }
    if (!nodesRef.current.some((node) => node.id === id)) return;
    touchGraph(nodesRef.current.map((node) => node.id === id
      ? { ...node, dragging: true, vx: 0, vy: 0, shadeVx: 0, shadeVy: 0 }
      : node));
  };

  const moveNode = (id, x, y) => {
    if (proposalNodesRef.current.some((node) => node.id === id)) {
      const next = proposalNodesRef.current.map((node) => node.id === id
        ? {
            ...node,
            x,
            y,
            dragging: true,
            vx: 0,
            vy: 0,
            shadeVx: x - node.x,
            shadeVy: y - node.y,
          }
        : node);
      proposalNodesRef.current = next;
      setProposalPositions(new Map(next.map((node) => [node.id, node])));
      return;
    }
    if (!nodesRef.current.some((node) => node.id === id)) return;
    touchGraph(nodesRef.current.map((node) => node.id === id
      ? { ...node, x, y, dragging: true, vx: 0, vy: 0, shadeVx: x - node.x, shadeVy: y - node.y }
      : node));
  };

  const finishMoveNode = (id, vx, vy, moved) => {
    if (drawerOpen || composer) setCameraRevealRequest((request) => request + 1);
    if (proposalNodesRef.current.some((node) => node.id === id)) {
      proposalDragStartRef.current.delete(id);
      const release = 0.08 + (1 - FLUID_PHYSICS_SETTINGS.viscosity) * 0.08;
      const next = proposalNodesRef.current.map((node) => {
        if (node.id !== id) return node;
        const released = {
          ...node,
          dragging: false,
          vx: moved ? clamp(vx, -24, 24) * release : 0,
          vy: moved ? clamp(vy, -24, 24) * release : 0,
          shadeVx: 0,
          shadeVy: 0,
        };
        return moved ? released : withWobble(released, 1, 0, 0.082);
      });
      proposalNodesRef.current = next;
      setProposalPositions(new Map(next.map((node) => [node.id, node])));
      return;
    }
    if (!nodesRef.current.some((node) => node.id === id)) return;
    const release = 0.08 + (1 - FLUID_PHYSICS_SETTINGS.viscosity) * 0.08;
    const next = nodesRef.current.map((node) => {
      if (node.id !== id) return node;
      const released = {
        ...node,
        dragging: false,
        vx: moved ? clamp(vx, -24, 24) * release : 0,
        vy: moved ? clamp(vy, -24, 24) * release : 0,
        shadeVx: 0,
        shadeVy: 0,
      };
      return moved ? released : withWobble(released, 1, 0, 0.082);
    });
    touchGraph(next);
    if (!moved) return;
    const node = next.find((candidate) => candidate.id === id);
    perform({ type: "move_bubble", node_reference: id, x: node.x, y: node.y })
      .catch((error) => showToast(error.message));
  };

  const cancelMoveNode = (id) => {
    if (proposalNodesRef.current.some((node) => node.id === id)) {
      const start = proposalDragStartRef.current.get(id);
      proposalDragStartRef.current.delete(id);
      if (start) {
        const next = proposalNodesRef.current.map((node) => node.id === id
          ? { ...start, dragging: false, vx: 0, vy: 0, shadeVx: 0, shadeVy: 0 }
          : node);
        proposalNodesRef.current = next;
        setProposalPositions(new Map(next.map((node) => [node.id, node])));
      }
      return;
    }
    if (!nodesRef.current.some((node) => node.id === id)) return;
    touchGraph(nodesRef.current.map((node) => node.id === id
      ? { ...node, dragging: false, vx: 0, vy: 0, shadeVx: 0, shadeVy: 0 }
      : node));
  };

  const connectTarget = async (targetId, sourceId = connectFromId) => {
    if (!canConnect(sourceId, targetId, nodesRef.current, edgesRef.current)) return;
    const source = nodesRef.current.find((node) => node.id === sourceId);
    const target = nodesRef.current.find((node) => node.id === targetId);
    if (!source || !target) {
      setConnectFromId(null);
      return;
    }
    const pendingKey = connectionEndpointKey({ from: sourceId, to: targetId });
    const startedAt = performance.now();
    const pendingEdge = {
      id: `pending:${pendingKey}:${startedAt}`,
      from: sourceId,
      to: targetId,
      bend: 0,
      createdAt: startedAt,
      pending: true,
      ghost: false,
    };
    const nextNodes = applyConnectionGrowthMotion(
      nodesRef.current,
      pendingEdge,
      { reducedMotion: reducedMotionRef.current },
    );
    const nextEdges = captureFluidRestLengths(
      nextNodes,
      [...edgesRef.current, pendingEdge],
      {},
    );
    const visualPendingEdge = nextEdges.find((edge) => edge.id === pendingEdge.id) ?? pendingEdge;
    pendingManualConnectionsRef.current.set(pendingKey, {
      edge: visualPendingEdge,
      startedAt,
    });
    touchGraph(nextNodes, nextEdges);
    try {
      await perform({ type: "connect_bubbles", from_reference: sourceId, to_reference: targetId });
      selectOne(targetId);
    } catch (error) {
      showToast(error.message);
    } finally {
      const unresolved = pendingManualConnectionsRef.current.get(pendingKey);
      if (unresolved?.edge.id === pendingEdge.id) {
        pendingManualConnectionsRef.current.delete(pendingKey);
        touchGraph(
          nodesRef.current,
          edgesRef.current.filter((edge) => edge.id !== pendingEdge.id),
        );
      }
      setConnectFromId(null);
    }
  };

  const removeConnection = (edge, motion = {}) => {
    const canonicalEdge = canonicalRef.current?.edges?.find((candidate) => (
      candidate.id === edge.id
      || (candidate.from === edge.from && candidate.to === edge.to)
      || (candidate.from === edge.to && candidate.to === edge.from)
    ));
    if (!canonicalEdge) return false;
    const key = connectionEdgeKey(canonicalEdge);
    manualPopKeysRef.current.add(key);
    const pendingPop = [...connectionPopQueueRef.current].reverse().find((pop) => (
      connectionMatches(canonicalEdge, {
        id: pop.edgeId,
        from: pop.aId,
        to: pop.bId,
      })
    ));
    if (pendingPop) pendingPop.hideUntilResolved = true;
    const transition = buildConnectionPopTransition(nodesRef.current, canonicalEdge, motion, {
      reducedMotion: reducedMotionRef.current,
      includePop: false,
    });
    touchGraph(transition.nodes);
    perform({ type: "delete_connection", edge_id: canonicalEdge.id })
      .then(() => {
        manualPopKeysRef.current.delete(key);
        if (pendingPop) pendingPop.hideUntilResolved = false;
        showToast("Connection popped");
      })
      .catch((error) => {
        manualPopKeysRef.current.delete(key);
        if (pendingPop) pendingPop.hideUntilResolved = false;
        showToast(error.message);
      });
    return true;
  };

  const rootId = useMemo(() => (
    canonical?.nodes?.find((node) => node.depth === 0)?.id ?? canonical?.nodes?.[0]?.id ?? null
  ), [canonical?.nodes]);

  const deleteBubble = (id) => {
    if (id === rootId) {
      showToast("The starting thought anchors this map");
      return;
    }
    perform({ type: "delete_bubble", node_reference: id })
      .then(() => selectOne(null))
      .catch((error) => showToast(error.message));
  };

  const spawnFreeform = (x, y) => {
    awaitingFirstContentRef.current = false;
    perform({
      type: "create_bubble",
      text: "New thought",
      create_distinct: true,
      parent_reference: null,
      x: clamp(x, 60, BASE_WIDTH - 60),
      y: clamp(y, 140, BASE_HEIGHT - 60),
    }).then((result) => {
      const createdId = result?.affected_ids?.[0];
      if (createdId) {
        selectOne(createdId);
        openThoughtEditor({ mode: "edit", id: createdId, fresh: true });
      }
    }).catch((error) => showToast(error.message));
  };

  const submitComposer = async (event) => {
    event.preventDefault();
    const text = composerValue.trim();
    if (!text || !composer || composerSubmissionRef.current) return;
    awaitingFirstContentRef.current = false;
    composerSubmissionRef.current = true;
    setComposerSaving(true);
    try {
      if (composer.mode === "edit") {
        await perform({ type: "edit_bubble", node_reference: composer.id, text });
        selectOne(composer.id);
      } else {
        const result = await perform({ type: "create_bubble", text, create_distinct: true, parent_reference: composer.parentId ?? null, ...(composer.position ?? {}) });
        const createdId = result?.affected_ids?.[0];
        if (createdId) selectOne(createdId);
      }
      setCameraRevealRequest((request) => request + 1);
      setComposer(null);
      setComposerValue("");
    } catch (error) {
      showToast(error.message);
    } finally {
      composerSubmissionRef.current = false;
      setComposerSaving(false);
    }
  };

  const openNewThought = () => {
    if (composerSubmissionRef.current) return;
    setSelectionMode(null);
    setBubbleActionsId(null);
    setConnectFromId(null);
    const transform = cameraTransform(viewport, zoom, pan);
    const rect = availableCanvasRect();
    openThoughtEditor({ mode: "add", parentId: null, position: {
      x: clamp(((rect.left + rect.right) / 2 - transform.offsetX) / transform.scale, 60, BASE_WIDTH - 60),
      y: clamp(((rect.top + rect.bottom) / 2 - transform.offsetY) / transform.scale, 140, BASE_HEIGHT - 60),
    } });
  };

  const deleteSelected = async () => {
    const committedIds = new Set(canonicalRef.current?.nodes?.map((node) => node.id) ?? []);
    const deletable = selectedIds.filter((id) => id !== rootId && committedIds.has(id));
    if (!deletable.length) return;
    try {
      await perform({ type: "bulk_delete_bubbles", node_ids: deletable });
      setSelectedId(null);
      setSelectedIds([]);
    } catch (error) {
      showToast(error.message);
    }
  };

  const centerOnNode = (id, options) => {
    const node = nodesRef.current.find((candidate) => candidate.id === id);
    if (!node) return;
    applyCamera(cameraCenteredOn(node, viewport, availableCanvasRect(options), Math.max(DEFAULT_CAMERA_ZOOM, zoom)));
  };

  const adjustZoom = (factor) => {
    awaitingFirstContentRef.current = false;
    const rect = availableCanvasRect();
    applyCamera(zoomCameraAt(cameraRef.current, zoom * factor,
      { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }, viewport));
  };

  const fitMap = () => {
    awaitingFirstContentRef.current = false;
    rememberView();
    applyCamera(fitMapCamera(mapNodes, viewport, availableCanvasRect()));
    setFocusId(null);
  };

  const rememberView = () => {
    setPreviousViews((current) => [...current.slice(-11), { pan, zoom, focusId, viewMode, selectedId, selectedIds, drawerTab, drawerOpen }]);
  };

  const restorePreviousView = () => {
    const previous = previousViews.at(-1);
    if (!previous) return;
    skipCameraRevealRef.current = true;
    requestAnimationFrame(() => { skipCameraRevealRef.current = false; });
    setPan(previous.pan);
    setZoom(previous.zoom);
    setFocusId(previous.focusId);
    if (previous.viewMode !== viewMode) applyViewLayout(previous.viewMode);
    setViewMode(previous.viewMode);
    setSelectedId(previous.selectedId);
    setSelectedIds(previous.selectedIds);
    setDrawerTab(previous.drawerTab);
    setDrawerOpen(previous.drawerOpen);
    setPreviousViews((current) => current.slice(0, -1));
  };

  const applyViewLayout = (nextMode) => {
    if (nextMode === "hierarchy") {
      nodesRef.current.forEach((node) => organicPositionsRef.current.set(node.id, { x: node.x, y: node.y }));
      const next = layoutHierarchy(nodesRef.current, edgesRef.current);
      nodesRef.current = next;
      setNodes(next);
    } else {
      const next = nodesRef.current.map((node) => ({ ...node, ...(organicPositionsRef.current.get(node.id) ?? {}) }));
      nodesRef.current = next;
      setNodes(next);
    }
  };

  const changeView = (nextMode) => {
    if (nextMode === viewMode) return;
    rememberView();
    applyViewLayout(nextMode);
    setViewMode(nextMode);
    applyCamera(initialMapCamera(nodesRef.current, rootId, viewport, availableCanvasRect({ ignoreDrawer: true })));
    setDrawerOpen(false);
    showToast(nextMode === "clusters" ? "Cluster view" : "Hierarchy view");
  };

  const undo = () => perform({ type: "undo_map_change" }).catch((error) => showToast(error.message));
  const redo = () => perform({ type: "redo_map_change" }).catch((error) => showToast(error.message));

  const acceptProposal = (proposal) => perform({ type: "accept_proposal", proposal_id: proposal.id })
    .catch((error) => showToast(error.message));

  const dismissProposal = (proposal) => perform({ type: "dismiss_proposal", proposal_id: proposal.id })
    .catch((error) => showToast(error.message));

  const excludeProposalOperation = (proposal, operation) => perform({
    type: "exclude_proposal_operation",
    proposal_id: proposal.id,
    operation_id: operation.id,
  }).catch((error) => showToast(error.message));

  const openEvidence = (utteranceId, nodeId = null, spans = null) => {
    rememberView();
    setDrawerOpen(true);
    setDrawerTab("conversation");
    setHighlight({ utteranceId, nodeId, spans });
    window.setTimeout(() => utteranceElementsRef.current.get(utteranceId)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  const askAboutBubble = (id) => {
    const node = [...nodesRef.current, ...proposalNodesRef.current].find((candidate) => candidate.id === id);
    if (!node) return;
    rememberView();
    selectOne(id);
    setDrawerOpen(true);
    setDrawerTab("conversation");
    setChatValue(`Let’s explore ${node.ghost ? "this suggestion" : "this thought"}: “${nodeLabel(node)}”. `);
    window.setTimeout(() => chatInputRef.current?.focus(), 50);
  };

  const toggleFocus = () => {
    rememberView();
    if (focusId) {
      setFocusId(null);
      showToast("Showing the full map");
    } else if (selectedId && !selectedId.startsWith("proposal-node-")) {
      setFocusId(selectedId);
      centerOnNode(selectedId);
      showToast("Focused this branch");
    } else {
      showToast("Select a committed bubble first");
    }
  };

  const openDrawer = (tab) => {
    if (drawerOpen && drawerTab === tab) setDrawerOpen(false);
    else {
      if (!drawerOpen) rememberView();
      setDrawerTab(tab);
      setDrawerOpen(true);
    }
  };

  const createNewMap = async () => {
    try {
      const created = snapshotFrom(await createSession({}));
      await refreshSessions();
      await openSession(created.id);
    } catch (error) {
      showToast(error.message);
    }
  };

  const newExample = async () => {
    try { const created = await client.createExample(); await openSession(created.id); }
    catch (error) { showToast(error.message); }
  };

  const importExample = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("Choose a session file smaller than 10 MB.");
      const created = await client.importSession(JSON.parse(await file.text()));
      await openSession(created.id);
    } catch (error) { showToast(`Could not import this session: ${error.message}`); }
  };

  const saveRename = async (event) => {
    event.preventDefault();
    const title = renameValue.trim();
    if (!renameId || !title) return;
    try {
      const result = await renameSession(renameId, title);
      const snapshot = snapshotFrom(result);
      if (snapshot?.id === canonicalRef.current?.id) applyCanonicalSnapshot(snapshot);
      await refreshSessions();
      setRenameId(null);
    } catch (error) {
      showToast(error.message);
    }
  };

  const removeMap = async (item) => {
    if (!window.confirm(`Delete “${item.title}”? This local session cannot be recovered.`)) return;
    try {
      const removingCurrent = item.id === sessionIdRef.current;
      if (removingCurrent) stopRealtime();
      await deleteSession(item.id);
      const listed = await refreshSessions();
      let nextId = listed.activeSessionId ?? listed.sessions[0]?.id;
      if (!nextId) nextId = snapshotFrom(await createSession({})).id;
      if (removingCurrent) await openSession(nextId);
    } catch (error) {
      showToast(error.message);
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
    const handleKeyDown = (event) => {
      const target = event.target;
      const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
      if (event.key === "Escape") {
        if (selectionPickerOpen) {
          setSelectionPickerOpen(false);
          selectionPickerRef.current?.querySelector('[data-testid="selection-tools"]')?.focus();
        }
        if (marqueeActive) {
          setSelectionMode(null);
          setSelectedIds([]);
          setSelectedId(null);
        }
        if (!composerSubmissionRef.current) setComposer(null);
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

  const pendingProposals = useMemo(() => (
    (canonical?.proposals ?? []).filter((proposal) => proposal.status === "pending" || proposal.status === "stale")
  ), [canonical?.proposals]);
  const ghostVisuals = useMemo(
    () => proposalVisuals(pendingProposals, nodes, proposalPositions),
    [pendingProposals, nodes, proposalPositions],
  );
  proposalNodesRef.current = ghostVisuals.ghostNodes;
  useLayoutEffect(() => {
    if (!canonical?.id || workspaceRestoredRef.current !== canonical.id) return;
    const previousViewport = previousViewportRef.current;
    previousViewportRef.current = viewport;
    const requestedReveal = previousRevealRequestRef.current !== cameraRevealRequest;
    previousRevealRequestRef.current = cameraRevealRequest;
    const crossedBreakpoint = (previousViewport.width <= 760) !== (viewport.width <= 760);
    const selectedNode = [...nodesRef.current, ...proposalNodesRef.current].find((node) => node.id === selectedId);
    const rect = availableCanvasRect();
    const firstContent = awaitingFirstContentRef.current && nodesRef.current.length > 0;
    if (firstContent) awaitingFirstContentRef.current = false;
    if (initialCameraRef.current || crossedBreakpoint || firstContent) {
      initialCameraRef.current = false;
      const visibleNodes = showSuggestionsRef.current ? [...nodesRef.current, ...proposalNodesRef.current] : nodesRef.current;
      const initial = selectedNode
        ? cameraCenteredOn(selectedNode, viewport, rect)
        : initialMapCamera(visibleNodes, rootId, viewport, rect);
      applyCamera(revealNodeCamera(initial, selectedNode, viewport, rect));
      return;
    }
    if (skipCameraRevealRef.current) {
      skipCameraRevealRef.current = false;
      return;
    }
    // Never chase physics frames or move the canvas under a drag in progress.
    if (selectedNode?.dragging || (!requestedReveal && !drawerOpen && !composer && viewport === previousViewport)) return;
    applyCamera(revealNodeCamera(cameraRef.current, selectedNode, viewport, rect));
  }, [canonical?.id, Boolean(canonical?.nodes?.length), selectedId, drawerOpen, drawerWidth, Boolean(composer), cameraRevealRequest, viewport, availableCanvasRect, applyCamera]);
  const previousProposalEdges = new Map(proposalEdgesRef.current.map((edge) => [edge.id, edge]));
  const retainedProposalEdges = ghostVisuals.ghostEdges.map((edge) => {
    const previous = previousProposalEdges.get(edge.id);
    return previous?.rest ? { ...edge, rest: previous.rest, restDx: previous.restDx, restDy: previous.restDy } : edge;
  });
  const physicalProposalEdges = captureFluidRestLengths(
    [...nodes, ...ghostVisuals.ghostNodes],
    retainedProposalEdges,
    { includeGhosts: true },
  );
  proposalEdgesRef.current = physicalProposalEdges;
  const mapNodes = useMemo(
    () => (showSuggestions ? [...nodes, ...ghostVisuals.ghostNodes] : nodes),
    [ghostVisuals.ghostNodes, nodes, showSuggestions],
  );
  const mapEdges = useMemo(
    () => (showSuggestions ? [...edges, ...physicalProposalEdges] : edges),
    [edges, physicalProposalEdges, showSuggestions],
  );
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

  const renderUtteranceText = (utterance) => {
    if (highlight?.utteranceId !== utterance.id) return utterance.text;
    const provenanceNode = highlight.nodeId ? nodes.find((node) => node.id === highlight.nodeId) : null;
    const spans = [...(highlight.spans ?? (provenanceNode?.sources ?? [])
      .filter((source) => source.utteranceId === utterance.id)
      .map((source) => source.span))]
      .sort((a, b) => a[0] - b[0]);
    if (!spans.length) return utterance.text;
    const parts = [];
    let cursor = 0;
    spans.forEach(([start, end], index) => {
      if (start > cursor) parts.push(utterance.text.slice(cursor, start));
      parts.push(<mark key={`${start}-${end}-${index}`}>{utterance.text.slice(Math.max(start, cursor), end)}</mark>);
      cursor = Math.max(cursor, end);
    });
    if (cursor < utterance.text.length) parts.push(utterance.text.slice(cursor));
    return parts;
  };

  const drawerPresentation = {
    maps: { eyebrow: "Workspace", title: "Your maps", icon: IconMap2 },
    sources: { eyebrow: "Exact words", title: "Thought sources", icon: IconQuote },
    conversation: { eyebrow: "Session", title: "Conversation", icon: IconMessageCircle },
    activity: { eyebrow: "Timeline", title: "Map activity", icon: IconClock },
    search: { eyebrow: "Find", title: "Search this map", icon: IconSearch },
    proposals: { eyebrow: "Review", title: "Suggestions", icon: IconSparkles },
    layouts: { eyebrow: "One graph", title: "Switch the view", icon: IconHierarchy2 },
    overview: { eyebrow: "Your thinking, together", title: "Synthesis", icon: IconGridDots },
    layers: { eyebrow: "Visibility", title: "Canvas layers", icon: IconStack2 },
    profile: { eyebrow: "Local profile", title: example ? "TF" : "MR", icon: IconUser },
    settings: { eyebrow: "Preferences", title: "Session settings", icon: IconSettings },
  };
  const presentation = drawerPresentation[drawerTab] ?? drawerPresentation.conversation;
  const DrawerIcon = presentation.icon;
  const timer = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const voiceConnected = realtimeRef.current?.connected;
  const voiceStarting = ["connecting", "requesting_microphone", "reconnecting", "ending"].includes(voiceState);
  const controllerStatus = mapControllerPresentation(canonical?.map_controller, {
    activeVisible: controllerActivity.sessionId === canonical?.id
      && controllerActivity.active
      && controllerActivity.visible,
  });
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

  const acceptGhost = (ghostId) => {
    const ghost = ghostVisuals.ghostNodes.find((node) => node.id === ghostId);
    const proposal = pendingProposals.find((candidate) => candidate.id === ghost?.proposalId);
    if (proposal) acceptProposal(proposal);
  };
  const dismissGhost = (ghostId) => {
    const ghost = ghostVisuals.ghostNodes.find((node) => node.id === ghostId);
    const proposal = pendingProposals.find((candidate) => candidate.id === ghost?.proposalId);
    if (proposal) dismissProposal(proposal);
  };

  return (
    <main ref={shellRef} className={`app-shell paper session-shell canonical-session-shell ${example ? "is-example" : ""} ${drawerOpen ? "has-workspace-drawer" : ""}`} style={{ "--session-drawer-width": `${drawerWidth}px` }}>
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
          setSelectedIds(filtered);
          setSelectedId(filtered.length === 1 ? filtered[0] : null);
        }}
        onMoveStart={startMoveNode}
        onMoveNode={moveNode}
        onMoveEnd={finishMoveNode}
        onMoveCancel={cancelMoveNode}
        onEdit={(id) => {
          const node = nodesRef.current.find((candidate) => candidate.id === id);
          if (!node) return;
          openThoughtEditor({ mode: "edit", id }, nodeLabel(node));
        }}
        onAdd={(parentId) => openThoughtEditor({ mode: "add", parentId })}
        onAskAI={example ? undefined : askAboutBubble}
        controlsHidden={Boolean(composer)}
        onPin={(id) => perform({ type: "set_node_pinned", node_id: id, pinned: !nodesRef.current.find((node) => node.id === id)?.pinned }).catch((error) => showToast(error.message))}
        onPark={(id) => perform({ type: "set_node_parked", node_id: id, parked: !nodesRef.current.find((node) => node.id === id)?.parked }).catch((error) => showToast(error.message))}
        onSources={(id) => { selectOne(id); rememberView(); setDrawerTab("sources"); setDrawerOpen(true); }}
        onArmConnect={armConnection}
        onCancelConnect={cancelConnection}
        onConnect={(sourceId, targetId) => connectTarget(targetId, sourceId)}
        actionsNodeId={bubbleActionsId}
        onActionsChange={setBubbleActionsId}
        rootId={rootId}
        onSpawnFreeform={spawnFreeform}
        onDelete={deleteBubble}
        onAcceptGhost={acceptGhost}
        onDismissGhost={dismissGhost}
        onRemoveConnection={removeConnection}
        connectFromId={connectFromId}
        zoom={zoom}
        setZoom={zoomCanvas}
        pan={pan}
        setPan={panCanvas}
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
          <p>{example ? "A little room to think." : "Say what you're thinking."}</p>
          <small>{example ? "Double-click the canvas to add a thought." : "Double-click the canvas to add a thought, or start talking."}</small>
        </div>
      )}
      {loading && <div className="session-loading" role="status">Opening your map…</div>}
      {loadError && <div className="session-open-error" role="alert"><p>{loadError}</p><button type="button" onClick={() => window.location.reload()}>Retry opening</button></div>}

      <header className="session-identity" aria-label="Current map">
        {example && <span className="session-example-label">Example</span>}
        {renameId === canonical?.id ? (
          <form onSubmit={saveRename}>
            <input aria-label="Map name" autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setRenameId(null); }} />
            <IconButton type="submit" label="Save map name" disabled={!renameValue.trim()}><IconCheck /></IconButton>
            <IconButton label="Cancel rename" onClick={() => setRenameId(null)}><IconX /></IconButton>
          </form>
        ) : <button type="button" className="session-title" title="Rename map" onClick={() => { if (canonical) { setRenameId(canonical.id); setRenameValue(canonical.title); } }}><span>{canonical?.title ?? "Opening map…"}</span><IconPencil /></button>}
        <small className={!syncConnected || saveFailure ? "is-disconnected" : ""} role="status">{loadError ? "Could not open saved map" : !canonical ? "Opening your map…" : saveFailure ? "Changes not saved" : !syncConnected ? "Reconnecting to local save…" : pendingWrites || busy || preferenceBusy || synthesizing ? "Saving…" : "Saved"}</small>
        {saveFailure && <span className="session-save-error" role="alert">{saveFailure}</span>}
      </header>

      <nav className="side-rail session-side-rail" aria-label="Workspace and session tools">
        <div className="session-rail-home">
          <RailButton label="Maps" active={drawerOpen && drawerTab === "maps"} expanded={drawerOpen && drawerTab === "maps"} onClick={() => openDrawer("maps")} className="session-brand-button" testId="maps-tool"><IconAffiliate /></RailButton>
        </div>
        <div className="session-rail-group" role="group" aria-label="Your workspace">
          <RailButton label="Conversation" active={drawerOpen && drawerTab === "conversation"} expanded={drawerOpen && drawerTab === "conversation"} onClick={() => openDrawer("conversation")} testId="conversation-tool"><IconMessageCircle /></RailButton>
          <RailButton label="Search" active={drawerOpen && drawerTab === "search"} expanded={drawerOpen && drawerTab === "search"} onClick={() => openDrawer("search")} testId="search-tool"><IconSearch /></RailButton>
          <RailButton label="Activity" active={drawerOpen && drawerTab === "activity"} expanded={drawerOpen && drawerTab === "activity"} onClick={() => openDrawer("activity")} testId="activity-tool"><IconClock /></RailButton>
        </div>
        <div className="session-rail-divider" />
        <div className="session-rail-group" role="group" aria-label="This map">
          <RailButton label={focusId ? "Show full map" : "Focus selected branch"} active={Boolean(focusId)} pressed={Boolean(focusId)} onClick={toggleFocus} testId="focus-tool"><IconFocusCentered /></RailButton>
          <RailButton label={favorite ? "Remove favorite" : "Add favorite"} pressed={favorite} className="session-favorite-button" onClick={() => setFavorite((value) => !value)} testId="favorite-tool"><IconStar /></RailButton>
        </div>
        <div className="session-rail-group session-rail-footer" role="group" aria-label="Account and preferences">
          <RailButton label="Settings" active={drawerOpen && drawerTab === "settings"} expanded={drawerOpen && drawerTab === "settings"} onClick={() => openDrawer("settings")} testId="settings-tool"><IconSettings /></RailButton>
          <RailButton label="Account" active={drawerOpen && drawerTab === "profile"} expanded={drawerOpen && drawerTab === "profile"} onClick={() => openDrawer("profile")} className="avatar-button" testId="profile-tool">{example ? "TF" : "MR"}</RailButton>
        </div>
      </nav>

      <div className="top-dock" aria-label="Canvas modes">
        <IconButton label="New thought" onClick={openNewThought} disabled={composerSaving} testId="new-thought-tool"><IconPlus /></IconButton>
        <div className="selection-picker" ref={selectionPickerRef} onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setSelectionPickerOpen(false);
        }}>
          <button type="button" className={`icon-button selection-picker-trigger ${marqueeActive || selectionPickerOpen ? "is-active" : ""}`}
            aria-label="Selection tools" title="Selection tools" aria-expanded={selectionPickerOpen} aria-controls="selection-modes"
            onClick={() => setSelectionPickerOpen((value) => !value)} data-testid="selection-tools">
            {selectionMode === "lasso" ? <IconLasso /> : <IconMarquee />}<IconChevronDown className="selection-picker-chevron" />
          </button>
          {selectionPickerOpen && <div id="selection-modes" className="selection-picker-menu" role="group" aria-label="Selection mode">
            {[["rectangle", "Rectangle select", IconMarquee], ["lasso", "Lasso select", IconLasso]].map(([mode, label, ModeIcon]) => (
              <button type="button" key={mode} aria-pressed={selectionMode === mode} data-selection-option
                data-testid={mode === "lasso" ? "lasso-tool" : "marquee-tool"}
                onClick={() => {
                  setSelectionMode((current) => current === mode ? null : mode);
                  setSelectedIds([]); setSelectedId(null); setSelectionPickerOpen(false);
                  selectionPickerRef.current?.querySelector('[data-testid="selection-tools"]')?.focus();
                }}>
                <ModeIcon /><span>{label}</span>{selectionMode === mode && <IconCheck className="selection-picker-check" />}
              </button>
            ))}
            <small>Esc to exit selection</small>
          </div>}
        </div>
        <IconButton label={`${pendingProposals.length} ${pendingProposals.length === 1 ? "suggestion" : "suggestions"}`} active={drawerOpen && drawerTab === "proposals"} onClick={() => openDrawer("proposals")} testId="ai-tool"><IconSparkles />{pendingProposals.length > 0 && <i className="tool-pip">{pendingProposals.length}</i>}</IconButton>
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

      {drawerOpen && (
        <aside className="session-drawer" aria-label={presentation.title} data-testid={`${drawerTab}-panel`}>
          <header className="panel-header session-panel-header">
            <div className="panel-title-mark"><DrawerIcon /></div>
            <div><span>{presentation.eyebrow}</span><h2>{presentation.title}</h2></div>
            <IconButton label="Close panel" onClick={() => setDrawerOpen(false)} className="panel-close"><IconX /></IconButton>
          </header>

          {["conversation", "sources", "proposals", "overview"].includes(drawerTab) && <div className="session-tabs session-primary-tabs" role="tablist" aria-label="Session details">
            {[["conversation", "Conversation", IconMessageCircle], ["sources", "Sources", IconQuote], ["proposals", "Suggestions", IconSparkles], ["overview", "Synthesis", IconGridDots]].map(([tab, label, TabIcon]) => (
              <button key={tab} type="button" role="tab" aria-selected={drawerTab === tab} className={drawerTab === tab ? "is-active" : ""} onClick={() => setDrawerTab(tab)} title={label}><TabIcon /><span>{label}</span>{tab === "proposals" && pendingProposals.length > 0 && <i>{pendingProposals.length}</i>}</button>
            ))}
          </div>}
          <div className="session-resize-handle" role="separator" aria-label="Resize detail panel" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={560} aria-valuenow={drawerWidth} aria-valuetext={`${Math.round(drawerWidth)} pixels wide`} tabIndex={0} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); setDrawerWidth((width) => clamp(width + (event.key === "ArrowRight" ? 20 : -20), 300, 560)); } }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setDrawerWidth(clamp(event.clientX - event.currentTarget.parentElement.getBoundingClientRect().left, 300, Math.min(560, window.innerWidth - event.currentTarget.parentElement.getBoundingClientRect().left - 20))); }} onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />

          {drawerTab === "maps" ? (
            <div className="session-maps-panel">
              <button type="button" className="wide-action session-new-map" onClick={createNewMap}><IconPlus />New map</button>
              {example && <div className="session-example-map-actions"><button type="button" className="wide-action" onClick={newExample}><IconPlus />New example copy</button><label className="wide-action session-import"><IconDownload />Import full session<input type="file" accept=".json,application/json" aria-label="Import full session" onChange={importExample} /></label></div>}
              <div className="session-map-list">
                {sessions.map((item) => (
                  <div key={item.id} className={`session-map-row ${item.id === canonical?.id ? "is-current" : ""}`}>
                    {renameId === item.id ? (
                      <form onSubmit={saveRename}>
                        <input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
                        <IconButton type="submit" label="Save map name" disabled={!renameValue.trim()}><IconCheck /></IconButton>
                        <IconButton label="Cancel rename" onClick={() => setRenameId(null)}><IconX /></IconButton>
                      </form>
                    ) : (
                      <>
                        <button type="button" className="session-map-open" onClick={() => openSession(item.id)}>
                          <span><strong>{item.title}</strong><small>{item.thought_count ?? item.node_count ?? 0} {(item.thought_count ?? item.node_count ?? 0) === 1 ? "thought" : "thoughts"} · {formatUpdated(item.updated_at)}</small></span>
                          {item.id === canonical?.id && <IconCheck />}
                        </button>
                        <IconButton label="Rename map" onClick={() => { setRenameId(item.id); setRenameValue(item.title); }}><IconPencil /></IconButton>
                        <IconButton label="Delete map" className="danger-action" onClick={() => removeMap(item)}><IconTrash /></IconButton>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div className="panel-note"><IconEye /><span>{example ? "Each copy stays in this browser. Export a full session to keep it if you clear browser data." : "Your maps stay on this device, ready to pick up where you left off."}</span></div>
            </div>
          ) : drawerTab === "conversation" ? (
            <>
              {example && <p className="session-example-note">Illustrative conversation. Select a thought to inspect its exact sources.</p>}
              <div className="session-transcript" data-testid="transcript">
                {!canonical?.transcript?.length && <div className="session-conversation-empty"><IconMessageCircle /><h3>A little room to think.</h3><p>Start with a thought, a question, or something you haven’t figured out yet.</p></div>}
                {conversationTimeline.map((turn) => {
                  const firstUtterance = turn.utterances[0];
                  const highlighted = turn.utterances.some((utterance) => utterance.id === highlight?.utteranceId);
                  const timestamp = firstUtterance?.completed_at ?? turn.actions[0]?.createdAt;
                  return (
                    <div key={turn.id} className={`session-utterance ${turn.speaker} ${highlighted ? "is-highlighted" : ""}`}>
                      <time>{turn.speaker === "you" ? "You" : "Partner"} · {formatClock(timestamp)}</time>
                      {groupUtterancesByPause(turn.utterances).map((group, groupIndex) => (
                        <React.Fragment key={group[0].id}>
                        {groupIndex > 0 && <time className="session-turn-pause">{formatClock(group[0].completed_at)}</time>}
                        <p>
                          {group.map((utterance, index) => (
                            <React.Fragment key={utterance.id}>
                              {index > 0 && " "}
                              <span
                                ref={(element) => {
                                  if (element) utteranceElementsRef.current.set(utterance.id, element);
                                  else utteranceElementsRef.current.delete(utterance.id);
                                }}
                                className="session-utterance-fragment"
                              >
                                {renderUtteranceText(utterance)}
                              </span>
                            </React.Fragment>
                          ))}
                        </p>
                        </React.Fragment>
                      ))}
                      {turn.actions.length > 0 && (
                        <div className="session-turn-actions" aria-label="Partner map actions">
                          {turn.actions.map((action) => <span key={action.id}>{action.label}</span>)}
                        </div>
                      )}
                    </div>
                  );
                })}
                <div ref={transcriptEndRef} />
              </div>
              {chatFailure?.sessionId === canonical?.id && <p className="session-recovery-note" role="status">{chatFailure.message}</p>}
              {!example && <form className="session-chat" onSubmit={submitChat}>
                <input ref={chatInputRef} value={chatValue} onChange={(event) => { chatSubmissions.edit(sessionIdRef.current, event.target.value); setChatFailure(null); setChatValue(event.target.value); }} aria-label="Message" placeholder={selected ? "Talk about the selected thought…" : "Type a thought…"} />
                <IconButton type="submit" label="Send" disabled={!chatValue.trim() || busy}><IconSend /></IconButton>
              </form>}
            </>
          ) : drawerTab === "activity" ? (
            <>
              <div className="history-actions">
                <IconButton label={undoLabel} onClick={undo} disabled={!canonical?.history_cursor}><IconArrowBackUp /></IconButton>
                <IconButton label={canonical?.redo_label ? `Redo ${canonical.redo_label}` : "Redo map change"} onClick={redo} disabled={!canRedo}><IconArrowForwardUp /></IconButton>
              </div>
              <div className="session-ledger">
                {!canonical?.operations?.length && <p className="empty-state">Every map change lands here with who made it.</p>}
                {[...(canonical?.operations ?? [])].reverse().map((entry) => (
                  <div key={entry.id} className={`session-ledger-entry actor-${entry.actor}`}>
                    <span>{actorLabel(entry.actor)}</span><p>{activityLabel(entry)}</p><small>{formatClock(entry.created_at ?? entry.at)}</small>
                  </div>
                ))}
              </div>
            </>
          ) : drawerTab === "search" ? (
            <div className="session-search-panel">
              <label className="search-field"><IconSearch /><input aria-label="Search thoughts" autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search thoughts…" /></label>
              <div className="panel-list search-results">
                {searchResults.map((node) => <button type="button" key={node.id} onClick={() => { rememberView(); selectOne(node.id); setFocusId(node.id); centerOnNode(node.id, { ignoreDrawer: true }); setDrawerOpen(false); }}><span>{nodeLabel(node)}</span></button>)}
                {!searchResults.length && <p className="empty-state">No matching thoughts yet.</p>}
              </div>
            </div>
          ) : drawerTab === "sources" ? (
            <div className="session-panel-copy session-sources">
              {selected ? <><h3>{nodeLabel(selected)}</h3>{selected.sources?.length ? selected.sources.map((source, index) => {
                const utterance = canonical.transcript.find((item) => item.id === source.utteranceId);
                return utterance ? <blockquote key={`${source.utteranceId}-${index}`}><p>{utterance.text.slice(source.span[0], source.span[1])}</p><footer>{utterance.speaker === "you" ? "You" : "Partner"} · {formatClock(utterance.completed_at)}<button type="button" onClick={() => openEvidence(utterance.id, selected.id)}>Show in conversation</button></footer></blockquote> : null;
              }) : <p>{selected.ghost ? "This suggestion goes beyond the conversation. Review its reasoning in Suggestions." : "This thought was added directly to the map."}</p>}</> : <p>Select a thought to see the exact words it came from.</p>}
            </div>
          ) : drawerTab === "proposals" ? (
            <div className="session-panel-copy session-suggestions-list">
              <label className="session-setting-row"><span><strong>Show on canvas</strong><small>Suggestions stay separate until accepted</small></span><input type="checkbox" checked={showSuggestions} onChange={(event) => setShowSuggestions(event.target.checked)} /></label>
              {!pendingProposals.length && <p className="empty-state">No suggestions.</p>}
              {pendingProposals.map((proposal) => (
                <article key={proposal.id} className={`session-proposal ${proposal.status === "stale" ? "is-stale" : ""}`} data-testid="partner-proposal">
                  <header><i className="session-proposal-mark"><IconSparkles /></i><span>Suggestion</span></header>
                  <p>{proposal.rationale}</p>
                  {proposal.status === "stale" && <small>This suggestion no longer fits the current map.</small>}
                  <div className="session-proposal-operations">{(proposal.operations ?? []).map((operation) => <div key={operation.id} className={operation.excluded ? "is-excluded" : ""}><span>{proposalOperationLabel(operation)}</span>{proposal.status === "pending" && !operation.excluded && <IconButton label="Exclude this change" onClick={() => excludeProposalOperation(proposal, operation)}><IconX /></IconButton>}</div>)}</div>
                  <details className="session-proposal-evidence"><summary>Why this idea?</summary><p>{proposal.rationale}</p>{(proposal.evidence ?? []).map((evidence, index) => {
                    const utteranceId = evidence.utterance_id ?? (typeof evidence === "string" ? evidence : null);
                    const spans = Number.isInteger(evidence?.start) && Number.isInteger(evidence?.end) ? [[evidence.start, evidence.end]] : null;
                    return utteranceId ? <button key={`${utteranceId}-${index}`} type="button" className="session-evidence" onClick={() => openEvidence(utteranceId, null, spans)}><IconQuote />{evidence.quote ? `“${evidence.quote}”` : "Conversation source"}</button> : null;
                  })}</details>
                  <footer>
                    {!example && <button type="button" className="session-proposal-explore" onClick={() => { const ghost = ghostVisuals.ghostNodes.find((node) => node.proposalId === proposal.id); if (ghost) askAboutBubble(ghost.id); else { setDrawerTab("conversation"); setChatValue(`Let’s explore this suggestion without changing the map: ${proposal.rationale}`); window.setTimeout(() => chatInputRef.current?.focus(), 50); } }}><IconMessageCircle />Explore</button>}
                    <IconButton label="Accept AI suggestion" className="session-accept" disabled={proposal.status === "stale" || !(proposal.operations ?? []).some((operation) => !operation.excluded)} onClick={() => acceptProposal(proposal)} testId="accept-suggestion"><IconCheck /></IconButton>
                    <IconButton label="Dismiss AI suggestion" className="session-dismiss" onClick={() => dismissProposal(proposal)} testId="dismiss-suggestion"><IconX /></IconButton>
                  </footer>
                </article>
              ))}
            </div>
          ) : drawerTab === "layouts" ? (
            <div className="session-panel-copy">
              <div className="segmented-control" aria-label="Graph layout">
                <button type="button" className={viewMode === "clusters" ? "is-active" : ""} onClick={() => changeView("clusters")}>Clusters</button>
                <button type="button" className={viewMode === "hierarchy" ? "is-active" : ""} onClick={() => changeView("hierarchy")}>Hierarchy</button>
              </div>
              <p className="panel-description">One map, two views.</p>
            </div>
          ) : drawerTab === "overview" ? (
            <div className="session-panel-copy">
              <div className="map-stats"><span><strong>{canonical?.nodes?.length ?? 0}</strong><small>Thoughts</small></span><span><strong>{canonical?.edges?.length ?? 0}</strong><small>Links</small></span><span><strong>{pendingProposals.length}</strong><small>Suggestions</small></span></div>
              {example ? <p className="session-example-note">The saved synthesis belongs to the example. Live generation is off.</p> : <button type="button" className="wide-action" disabled={synthesizing || !canonical?.nodes?.length} onClick={requestSynthesis}><IconSparkles />{synthesizing ? "Synthesizing…" : "Write a synthesis"}</button>}
              {synthesis && <><div className="session-synthesis"><p>{synthesis}</p></div><p className="session-synthesis-meta">Saved {formatUpdated(canonical?.synthesis?.created_at)}{canonical?.synthesis?.revision !== canonical?.revision ? " · The conversation may have moved on since this was written." : ""}</p></>}
              <div className="session-export-actions"><button type="button" onClick={() => downloadSessionExport(canonical.id, "markdown").catch((error) => showToast(error.message))}><IconDownload />Export notes</button><button type="button" onClick={() => downloadSessionExport(canonical.id, "json").catch((error) => showToast(error.message))}>Full session</button></div>
            </div>
          ) : drawerTab === "layers" ? (
            <div className="session-settings-panel">
              <label className="session-setting-row"><span><strong>Suggestions</strong><small>Show ghost branches and tethers</small></span><input type="checkbox" checked={showSuggestions} onChange={(event) => setShowSuggestions(event.target.checked)} /></label>
              <label className="session-setting-row"><span><strong>Provenance labels</strong><small>Reveal transcript-source labels on bubbles</small></span><input type="checkbox" checked={showProvenance} onChange={(event) => setShowProvenance(event.target.checked)} /></label>
            </div>
          ) : drawerTab === "profile" ? (
            <div className="session-profile-panel"><div className="profile-card"><span>{example ? "TF" : "MR"}</span><div><strong>{example ? "Example workspace" : "Solo workspace"}</strong><small>{example ? "Saved only in this browser" : "Private by default"}</small></div></div><div className="panel-note"><IconUser /><span>The transcript and accepted map stay together in this local session.</span></div></div>
          ) : (
            <div className="session-settings-panel">
              {!example && <><div className="session-voice-mode"><span><strong>Suggestions</strong><small>Quiet keeps conversation and mapping active. Proactive also offers new angles.</small></span><div className="segmented-control"><button type="button" disabled={preferenceBusy} className={partnerMode === "quiet" ? "is-active" : ""} onClick={() => setPreferences({ partner_mode: "quiet" })}>Quiet</button><button type="button" disabled={preferenceBusy} className={partnerMode === "proactive" ? "is-active" : ""} onClick={() => setPreferences({ partner_mode: "proactive" })}>Proactive</button></div></div><label className="session-setting-row"><span><strong>Pause mapping</strong><small>Keep talking; your full conversation is still saved</small></span><input type="checkbox" checked={mappingPaused} disabled={preferenceBusy} onChange={(event) => setPreferences({ mapping_paused: event.target.checked })} /></label></>}
              <label className="session-setting-row"><span><strong>Reduced motion</strong><small>Freeze deformation cues and reveal connections immediately</small></span><input type="checkbox" checked={reducedMotion} onChange={(event) => setReducedMotion(event.target.checked)} /></label>
              <label className="session-setting-row"><span><strong>Suggestions</strong><small>Show on canvas</small></span><input type="checkbox" checked={showSuggestions} onChange={(event) => setShowSuggestions(event.target.checked)} /></label>
            </div>
          )}
        </aside>
      )}

      {selected && !marqueeActive && !composer && <div className="session-selection-context" data-testid="selection-context">
        <div className="session-selection-label"><small>{selected.ghost ? "Suggestion" : selectedCanonical?.parked ? "Kept aside" : "Selected thought"}</small><strong title={nodeLabel(selected)}>{nodeLabel(selected)}</strong></div>
        <div className="session-context-actions">
          {!selected.ghost && <IconButton label="New connected thought" onClick={() => openThoughtEditor({ mode: "add", parentId: selected.id })} testId="add-connected-thought"><IconPlus /></IconButton>}
          {!selected.ghost && <IconButton label="More thought actions" testId="thought-more-actions" onClick={() => setBubbleActionsId((current) => current === selected.id ? null : selected.id)}><IconDots /></IconButton>}
          {selected.ghost && !example && <IconButton label="Explore suggestion" onClick={() => askAboutBubble(selected.id)}><IconMessageCircle /></IconButton>}
          {selectedProposal && <IconButton label="Review suggestion" onClick={() => { setDrawerTab("proposals"); setDrawerOpen(true); }}><IconSparkles /></IconButton>}
          <IconButton label="Clear selection" onClick={() => selectOne(null)}><IconX /></IconButton>
        </div>
      </div>}

      {recentChange && <div className="session-recent-change" role="status"><span>{recentChange.label}</span><button type="button" onClick={() => { rememberView(); const id = recentChange.nodeIds.find((candidate) => canonical.nodes.some((node) => node.id === candidate)); if (id) { selectOne(id); setFocusId(id); centerOnNode(id); } else { setDrawerTab("activity"); setDrawerOpen(true); } }}>Show</button><IconButton label={undoLabel} onClick={undo} disabled={!canonical?.history_cursor}><IconArrowBackUp /></IconButton><IconButton label="Dismiss recent change" onClick={() => setRecentChange(null)}><IconX /></IconButton></div>}

      {composer && (
        <form className="session-composer" onSubmit={submitComposer} aria-label={composer.fresh ? "New thought" : composer.mode === "edit" ? "Edit thought" : composer.parentId ? "New connected thought" : "New thought"}>
          <header className="thought-editor-header">
            <div><strong>{composer.fresh ? "New thought" : composer.mode === "edit" ? "Edit thought" : composer.parentId ? "New connected thought" : "New thought"}</strong>
              {composer.parentId && <small><IconLink />Connected to {nodeLabel(nodes.find((node) => node.id === composer.parentId) ?? { lines: ["selected thought"] })}</small>}
            </div>
            <IconButton label="Close thought editor" disabled={composerSaving} onClick={() => setComposer(null)}><IconX /></IconButton>
          </header>
          <textarea aria-label="Thought text" autoFocus rows="3" value={composerValue} disabled={composerSaving} onChange={(event) => setComposerValue(event.target.value)} placeholder="What's the thought?" onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit(); }
          }} />
          <footer className="thought-editor-footer"><small>Enter to save · Shift + Enter for a new line</small><button type="submit" disabled={!composerValue.trim() || composerSaving}>{composerSaving ? "Saving…" : composer.mode === "edit" ? "Save" : "Add thought"}</button></footer>
        </form>
      )}

      {(liveCaption || partnerCaption) && <div className="session-live-captions" aria-label="Live captions">
        {liveCaption && <div><span>You</span><p>{liveCaption}</p></div>}
        {partnerCaption && <div><span>Partner</span><p>{partnerCaption}</p></div>}
      </div>}

      {!example && <div className="session-conversation-controls">
        <div className="session-presence-controls" aria-label="Suggestion and mapping preferences">
          <button type="button" title={partnerMode === "quiet" ? "Quiet: conversation and capture, without unsolicited suggestions" : "Proactive: suggests useful new angles"} disabled={preferenceBusy} onClick={() => setPreferences({ partner_mode: partnerMode === "quiet" ? "proactive" : "quiet" })}><IconSparkles /><span>{partnerMode === "quiet" ? "Quiet" : "Proactive"}</span></button>
          <button type="button" className={mappingPaused ? "is-paused" : ""} title={mappingPaused ? "Resume mapping completed thoughts" : "Pause mapping; keep the conversation going"} aria-pressed={mappingPaused} disabled={preferenceBusy} onClick={() => setPreferences({ mapping_paused: !mappingPaused })}>{mappingPaused ? <IconPlayerPlay /> : <IconPlayerPause />}<span>{mappingPaused ? "Mapping paused" : "Mapping on"}</span></button>
        </div>
        <div className="session-backend-status" role="status" aria-live="polite">
          {canonical?.capture_status?.last_error && <div className="session-capture-error"><span>{canonical.capture_status.last_error}</span><button type="button" onClick={retryCapture} disabled={captureRetrying}>{captureRetrying ? "Retrying…" : "Retry thought capture"}</button></div>}
          {controllerStatus?.kind === "error" ? <><span>{controllerStatus.label}</span><button type="button" onClick={retryMapController} disabled={controllerRetrying}>{controllerRetrying ? "Retrying…" : "Retry"}</button></> : <span>{backendState === "working" ? "Partner is thinking…" : controllerStatus?.kind === "active" ? controllerStatus.label : mappingPaused ? "Your conversation is still being saved" : ""}</span>}
        </div>
        <div className={`voice-control ${voiceConnected && !muted ? "is-listening" : ""}`}>
          <span className="voice-timer">{voiceConnected ? timer : voiceStarting ? "Connecting…" : "Start talking"}</span>
          {voiceConnected ? <><IconButton label={muted ? "Unmute microphone" : "Mute microphone"} pressed={muted} disabled={mutePending} onClick={toggleMute} testId="voice-control">{muted ? <IconMicrophoneOff /> : <IconMicrophone />}</IconButton><IconButton label="End voice conversation" className="session-end-voice" onClick={endVoice}><IconPlayerStop /></IconButton></> : <IconButton label={voiceStarting ? "Cancel voice connection" : "Start voice conversation"} onClick={voiceStarting ? stopRealtime : startVoice} testId="voice-control">{voiceStarting ? <IconX /> : <IconMicrophone />}</IconButton>}
          {voiceConnected && <small className="session-mute-label">{muted ? "Mic muted" : "Listening"}</small>}
        </div>
      </div>}
      {voiceError && <div className="session-voice-error" role="status">{voiceError} <button type="button" onClick={() => setVoiceError("")}>Dismiss</button></div>}

      <div className="zoom-controls" aria-label="Canvas zoom"><IconButton label="Back to previous view" disabled={!previousViews.length} onClick={restorePreviousView}><IconArrowLeft /></IconButton><IconButton label={undoLabel} onClick={undo} disabled={!canonical?.history_cursor}><IconArrowBackUp /></IconButton><IconButton label="Fit map" onClick={fitMap}><IconFocusCentered /></IconButton><IconButton label="Zoom out" disabled={zoom <= MIN_CAMERA_ZOOM} onClick={() => adjustZoom(1 / 1.2)}><IconMinus /></IconButton><span>{Math.round(zoom * 100)}%</span><IconButton label="Zoom in" disabled={zoom >= MAX_CAMERA_ZOOM} onClick={() => adjustZoom(1.2)}><IconPlus /></IconButton></div>
      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </main>
  );
}
