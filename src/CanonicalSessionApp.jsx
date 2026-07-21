import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconAffiliate,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconCheck,
  IconClock,
  IconEye,
  IconFocusCentered,
  IconGridDots,
  IconHierarchy2,
  IconMap2,
  IconMarquee,
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
import { BASE_HEIGHT, BASE_WIDTH } from "./mapData.js";
import {
  FLUID_PHYSICS_SETTINGS,
  captureFluidRestLengths,
  stepFluidPhysics,
} from "./fluidPhysics.js";
import { clamp, withWobble } from "./fluidMaterial.js";
import { bubbleLines, updateBubbleRadii } from "./session/sizing.js";
import { condenseUtterance, informativeTokens, overlapScore } from "./session/condense.js";
import {
  applyConnectionGrowthMotion,
  buildConnectionPopTransition,
  connectionEdgeKey,
  connectionMatches,
} from "./session/connectionMotion.js";
import {
  actorLabel,
  activityLabel,
  proposalOperationLabel,
  proposalVisuals,
  visualizeSession,
} from "./session/presentation.js";
import {
  SessionApiError,
  applySessionOperation,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  renameSession,
  subscribeSessionEvents,
  synthesizeSession,
  updateSessionUiContext,
} from "./sessionApi.js";
import { createSessionRealtimeClient } from "./sessionRealtime.js";

const MIN_ZOOM = 0.72;
const MAX_ZOOM = 1.36;
const ZOOM_STEP = 0.08;
const REMENTION_MIN_OVERLAP = 2;
const REMENTION_COVERAGE = 0.6;
const ATTACH_MIN_OVERLAP = 1;

let bootstrapPromise;

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

async function bootstrapCanonicalSession() {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
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
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
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

function makeRealtimeItemId(prefix = "item") {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${value.replaceAll("-", "")}`;
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

export function CanonicalSessionApp() {
  const [canonical, setCanonical] = useState(null);
  const canonicalRef = useRef(null);
  const sessionIdRef = useRef(null);
  const committedPositionsRef = useRef(new Map());
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const organicPositionsRef = useRef(new Map());
  const connectionPopQueueRef = useRef([]);
  const manualPopKeysRef = useRef(new Set());

  const [selectedId, setSelectedId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [connectFromId, setConnectFromId] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [viewMode, setViewMode] = useState("clusters");
  const [focusId, setFocusId] = useState(null);
  const [marqueeActive, setMarqueeActive] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerTab, setDrawerTab] = useState("conversation");
  const [searchQuery, setSearchQuery] = useState("");
  const [favorite, setFavorite] = useState(true);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [showProvenance, setShowProvenance] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => (
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false
  ));
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  const [voiceMode, setVoiceMode] = useState("vad");

  const [chatValue, setChatValue] = useState("");
  const [composer, setComposer] = useState(null);
  const [composerValue, setComposerValue] = useState("");
  const [highlight, setHighlight] = useState(null);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [synthesis, setSynthesis] = useState("");
  const [synthesizing, setSynthesizing] = useState(false);
  const [renameId, setRenameId] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  const [voiceState, setVoiceState] = useState("idle");
  const [voiceError, setVoiceError] = useState("");
  const [liveCaption, setLiveCaption] = useState("");
  const [partnerCaption, setPartnerCaption] = useState("");
  const [seconds, setSeconds] = useState(0);
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
    if (
      currentSnapshot?.id === snapshot.id
      && Number.isFinite(currentSnapshot.revision)
      && Number.isFinite(snapshot.revision)
      && snapshot.revision < currentSnapshot.revision
    ) return;
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
    if (motionEnabled) {
      visual.addedEdges.forEach((edge) => {
        nextNodes = applyConnectionGrowthMotion(nextNodes, edge);
      });

      const nextNodeIds = new Set(nextNodes.map((node) => node.id));
      let transitionNodes = [
        ...nextNodes,
        ...nodesRef.current.filter((node) => !node.ghost && !nextNodeIds.has(node.id)),
      ];
      visual.removedEdges.forEach((edge) => {
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
      visual.removedEdges.forEach((edge) => manualPopKeysRef.current.delete(connectionEdgeKey(edge)));
    }

    const nextEdges = captureFluidRestLengths(nextNodes, visual.edges, {});
    canonicalRef.current = snapshot;
    sessionIdRef.current = snapshot.id;
    committedPositionsRef.current = visual.committedPositions;
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setCanonical(snapshot);
    setNodes(nextNodes);
    setEdges(nextEdges);
    setSessions((current) => {
      const next = current.filter((item) => item.id !== snapshot.id);
      return [summaryFromSession(snapshot), ...next];
    });
    setSelectedIds((current) => current.filter((id) => snapshot.nodes.some((node) => node.id === id)));
    setSelectedId((current) => (current && snapshot.nodes.some((node) => node.id === current) ? current : null));
  }, []);

  const stopRealtime = useCallback(() => {
    realtimeRef.current?.disconnect();
    realtimeRef.current = null;
    setVoiceState("idle");
    setLiveCaption("");
    setPartnerCaption("");
    setSeconds(0);
  }, []);

  const refreshSessions = useCallback(async () => {
    const payload = listPayload(await listSessions());
    setSessions(payload.sessions);
    return payload;
  }, []);

  const openSession = useCallback(async (id) => {
    if (!id) return;
    stopRealtime();
    setLoading(true);
    try {
      const snapshot = snapshotFrom(await getSession(id));
      committedPositionsRef.current = new Map();
      connectionPopQueueRef.current = [];
      manualPopKeysRef.current.clear();
      nodesRef.current = [];
      edgesRef.current = [];
      setSelectedId(null);
      setSelectedIds([]);
      setFocusId(null);
      setConnectFromId(null);
      setComposer(null);
      setComposerValue("");
      setMarqueeActive(false);
      setHighlight(null);
      setViewMode("clusters");
      organicPositionsRef.current = new Map();
      setPan({ x: 0, y: 0 });
      setZoom(1);
      setSynthesis("");
      applyCanonicalSnapshot(snapshot, { animateNew: false, allowSessionSwitch: true });
      await refreshSessions();
      setDrawerOpen(false);
    } catch (error) {
      showToast(error.message);
    } finally {
      setLoading(false);
    }
  }, [applyCanonicalSnapshot, refreshSessions, showToast, stopRealtime]);

  useEffect(() => {
    let cancelled = false;
    bootstrapCanonicalSession()
      .then(({ listed, snapshot }) => {
        if (cancelled) return;
        setSessions(listed.sessions);
        applyCanonicalSnapshot(snapshot, { animateNew: false });
        setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoading(false);
        showToast(error.message);
      });
    return () => { cancelled = true; };
  }, [applyCanonicalSnapshot, showToast]);

  useEffect(() => {
    if (!canonical?.id) return undefined;
    return subscribeSessionEvents(canonical.id, {
      onSnapshot: applyCanonicalSnapshot,
      onError: () => setVoiceError((current) => current || "Live updates are reconnecting…"),
      onOpen: () => setVoiceError((current) => (current === "Live updates are reconnecting…" ? "" : current)),
    });
  }, [canonical?.id, applyCanonicalSnapshot]);

  const perform = useCallback(async (operation, { actor = "you", callId } = {}) => {
    const id = sessionIdRef.current;
    if (!id || !canonicalRef.current) throw new Error("No map session is open");
    try {
      const result = await applySessionOperation(id, operation, {
        expectedRevision: canonicalRef.current.revision,
        callId,
        actor,
      });
      const snapshot = snapshotFrom(result);
      if (snapshot) applyCanonicalSnapshot(snapshot);
      if (result?.warnings?.length) showToast(result.warnings.join(" · "));
      return result;
    } catch (error) {
      if (error instanceof SessionApiError && error.snapshot) applyCanonicalSnapshot(error.snapshot);
      throw error;
    }
  }, [applyCanonicalSnapshot, showToast]);

  const appendUtterance = useCallback(async (speaker, text, realtimeItemId) => {
    const normalized = text?.trim();
    if (!normalized) return null;
    let result;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        result = await perform({
          type: "append_utterance",
          speaker,
          text: normalized,
          realtime_item_id: realtimeItemId ?? null,
          completed_at: new Date().toISOString(),
        }, { actor: speaker === "you" ? "you" : "partner" });
        break;
      } catch (error) {
        if (!(error instanceof SessionApiError)
          || error.code !== "revision_conflict"
          || attempt === 2) throw error;
      }
    }
    if (speaker === "you" && realtimeItemId) {
      await realtimeRef.current?.notifyTranscriptCommitted(realtimeItemId);
    }
    return result;
  }, [perform]);

  useEffect(() => {
    let animationFrame;
    let lastTime = performance.now();
    const animate = (now) => {
      const frameStep = clamp((now - lastTime) / 16.67, 0.35, 2);
      lastTime = now;
      const result = viewMode === "clusters"
        ? stepFluidPhysics(nodesRef.current, edgesRef.current, {
            frameStep,
            width: BASE_WIDTH,
            height: BASE_HEIGHT,
            settings: FLUID_PHYSICS_SETTINGS,
          })
        : { nodes: nodesRef.current.map((node) => ({ ...node })), active: false };
      const radiusActive = updateBubbleRadii(result.nodes, edgesRef.current, now, frameStep, { reducedMotion });
      if (result.active || radiusActive) {
        nodesRef.current = result.nodes;
        setNodes(result.nodes);
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
  }, [canonical?.id, canonical?.revision, canonical?.nodes?.length, canonical?.edges?.length, viewMode]);

  useEffect(() => {
    if (!realtimeRef.current?.connected) return undefined;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [voiceState]);

  useEffect(() => {
    if (!canonical?.id) return undefined;
    const timer = window.setTimeout(() => {
      updateSessionUiContext(canonical.id, {
        selected_node_ids: selectedIds,
        focus_id: focusId,
        view_mode: viewMode,
        voice_mode: voiceMode,
      }).catch(() => {});
    }, 100);
    return () => window.clearTimeout(timer);
  }, [canonical?.id, focusId, selectedIds, viewMode, voiceMode]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [canonical?.transcript?.length]);

  useEffect(() => () => stopRealtime(), [stopRealtime]);

  const selectOne = useCallback((id) => {
    if (id && !nodesRef.current.some((node) => node.id === id)) return;
    setSelectedId(id);
    setSelectedIds(id ? [id] : []);
  }, []);

  const touchGraph = (nextNodes) => {
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
  };

  const materializeTypedThought = useCallback(async (text, itemId) => {
    const ideas = condenseUtterance(text).slice(0, 3);
    for (const idea of ideas) {
      const tokens = new Map(nodesRef.current.map((node) => [node.id, informativeTokens(nodeLabel(node))]));
      let best = null;
      let bestScore = 0;
      tokens.forEach((candidateTokens, id) => {
        const score = overlapScore(idea.tokens, candidateTokens);
        if (score > bestScore) {
          best = nodesRef.current.find((node) => node.id === id);
          bestScore = score;
        }
      });
      const quote = text.slice(idea.span[0], idea.span[1]);
      const repeated = best && bestScore >= REMENTION_MIN_OVERLAP
        && bestScore / Math.max(idea.tokens.size, 1) >= REMENTION_COVERAGE;
      if (repeated) {
        await perform({
          type: "revisit_bubble",
          node_reference: best.id,
          transcript_quote: quote,
          realtime_item_id: itemId,
        }, { actor: "partner" });
      } else {
        await perform({
          type: "create_bubble",
          text: idea.label,
          parent_reference: bestScore >= ATTACH_MIN_OVERLAP ? best?.id ?? null : null,
          transcript_quote: quote,
          realtime_item_id: itemId,
        }, { actor: "partner" });
      }
    }
  }, [perform]);

  const submitChat = async (event) => {
    event.preventDefault();
    const text = chatValue.trim();
    if (!text || busy) return;
    setChatValue("");
    setBusy(true);
    try {
      if (realtimeRef.current?.connected) {
        await realtimeRef.current.sendText(text, {
          beforeResponse: ({ itemId }) => appendUtterance("you", text, itemId),
        });
      } else {
        const itemId = makeRealtimeItemId("text");
        await appendUtterance("you", text, itemId);
        await materializeTypedThought(text, itemId);
      }
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy(false);
    }
  };

  const buildRealtime = () => createSessionRealtimeClient({
    sessionId: sessionIdRef.current,
    voiceMode,
    audioElement: audioRef.current,
    getExpectedRevision: () => canonicalRef.current?.revision,
    onStateChange: ({ state }) => {
      setVoiceState(state);
      if (state === "connected") {
        setSeconds(0);
        setVoiceError("");
      }
    },
    onUserTranscriptPartial: ({ text }) => setLiveCaption(text),
    onInputTranscriptDone: async ({ text, itemId }) => {
      setLiveCaption("");
      await appendUtterance("you", text, itemId);
      return { committed: true };
    },
    onPartnerTranscriptPartial: ({ text }) => setPartnerCaption(text),
    onPartnerTranscriptFinal: ({ text, itemId }) => {
      setPartnerCaption("");
      appendUtterance("partner", text, itemId).catch((error) => showToast(error.message));
    },
    onToolResult: ({ result }) => {
      const snapshot = snapshotFrom(result);
      if (snapshot) applyCanonicalSnapshot(snapshot);
    },
    onError: (error) => setVoiceError(error.message),
  });

  const toggleVoice = async () => {
    if (realtimeRef.current?.connected || ["connecting", "requesting_microphone"].includes(voiceState)) {
      stopRealtime();
      showToast("Voice conversation paused");
      return;
    }
    if (!canonical?.id) return;
    setVoiceError("");
    const realtime = buildRealtime();
    realtimeRef.current = realtime;
    try {
      await realtime.connect({ voiceMode });
      showToast(voiceMode === "vad" ? "Voice conversation is live" : "Voice ready — hold the mic to talk");
    } catch (error) {
      realtimeRef.current = null;
      setVoiceError(error.message);
    }
  };

  const setNextVoiceMode = (mode) => {
    if (mode === voiceMode) return;
    stopRealtime();
    setVoiceMode(mode);
    showToast(mode === "vad" ? "Server voice detection selected" : "Push-to-talk selected");
  };

  const startPushToTalk = (event) => {
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      realtimeRef.current?.startPushToTalk();
    } catch (error) {
      setVoiceError(error.message);
    }
  };

  const stopPushToTalk = (event) => {
    try {
      realtimeRef.current?.stopPushToTalk();
    } catch (error) {
      setVoiceError(error.message);
    } finally {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  };

  const startMoveNode = (id) => {
    if (!nodesRef.current.some((node) => node.id === id)) return;
    touchGraph(nodesRef.current.map((node) => node.id === id
      ? { ...node, dragging: true, vx: 0, vy: 0, shadeVx: 0, shadeVy: 0 }
      : node));
  };

  const moveNode = (id, x, y) => {
    if (!nodesRef.current.some((node) => node.id === id)) return;
    touchGraph(nodesRef.current.map((node) => node.id === id
      ? { ...node, x, y, dragging: true, vx: 0, vy: 0, shadeVx: x - node.x, shadeVy: y - node.y }
      : node));
  };

  const finishMoveNode = (id, vx, vy, moved) => {
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
    if (!nodesRef.current.some((node) => node.id === id)) return;
    touchGraph(nodesRef.current.map((node) => node.id === id
      ? { ...node, dragging: false, vx: 0, vy: 0, shadeVx: 0, shadeVy: 0 }
      : node));
  };

  const connectTarget = async (targetId) => {
    if (!connectFromId || connectFromId === targetId) return;
    try {
      await perform({ type: "connect_bubbles", from_reference: connectFromId, to_reference: targetId });
      selectOne(targetId);
    } catch (error) {
      showToast(error.message);
    } finally {
      setConnectFromId(null);
    }
  };

  const removeConnection = (edge, motion = {}) => {
    const canonicalEdge = canonicalRef.current?.edges?.find((candidate) => (
      candidate.id === edge.id
      || (candidate.from === edge.from && candidate.to === edge.to)
      || (candidate.from === edge.to && candidate.to === edge.from)
    ));
    if (!canonicalEdge) return;
    const key = connectionEdgeKey(canonicalEdge);
    manualPopKeysRef.current.add(key);
    const transition = buildConnectionPopTransition(nodesRef.current, canonicalEdge, motion, {
      reducedMotion: reducedMotionRef.current,
      includePop: false,
    });
    touchGraph(transition.nodes);
    perform({ type: "delete_connection", edge_id: canonicalEdge.id })
      .then(() => {
        manualPopKeysRef.current.delete(key);
        showToast("Connection popped");
      })
      .catch((error) => {
        manualPopKeysRef.current.delete(key);
        showToast(error.message);
      });
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
    perform({
      type: "create_bubble",
      text: "New thought",
      parent_reference: null,
      x: clamp(x, 60, BASE_WIDTH - 60),
      y: clamp(y, 140, BASE_HEIGHT - 60),
    }).then((result) => {
      const createdId = result?.affected_ids?.[0];
      if (createdId) selectOne(createdId);
    }).catch((error) => showToast(error.message));
  };

  const submitComposer = async (event) => {
    event.preventDefault();
    const text = composerValue.trim();
    if (!text || !composer) return;
    try {
      if (composer.mode === "edit") {
        await perform({ type: "edit_bubble", node_reference: composer.id, text });
        selectOne(composer.id);
      } else {
        const result = await perform({ type: "create_bubble", text, parent_reference: composer.parentId ?? null });
        const createdId = result?.affected_ids?.[0];
        if (createdId) selectOne(createdId);
      }
      setComposer(null);
      setComposerValue("");
    } catch (error) {
      showToast(error.message);
    }
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

  const changeView = (nextMode) => {
    if (nextMode === viewMode) return;
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
    setViewMode(nextMode);
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setDrawerOpen(false);
    showToast(nextMode === "clusters" ? "Cluster view" : "Hierarchy view");
  };

  const undo = () => perform({ type: "undo_map_change" }).catch((error) => showToast(error.message));
  const redo = () => perform({ type: "redo_map_change" }).catch((error) => showToast(error.message));

  const acceptProposal = (proposal) => perform({ type: "accept_proposal", proposal_id: proposal.id })
    .then((result) => {
      if (result?.warnings?.some((warning) => /stale/i.test(warning))) showToast("Applied what still fit; stale changes were dropped");
    })
    .catch((error) => showToast(error.message));

  const dismissProposal = (proposal) => perform({ type: "dismiss_proposal", proposal_id: proposal.id })
    .catch((error) => showToast(error.message));

  const excludeProposalOperation = (proposal, operation) => perform({
    type: "exclude_proposal_operation",
    proposal_id: proposal.id,
    operation_id: operation.id,
  }).catch((error) => showToast(error.message));

  const openEvidence = (utteranceId, nodeId = null, spans = null) => {
    setDrawerOpen(true);
    setDrawerTab("conversation");
    setHighlight({ utteranceId, nodeId, spans });
    window.setTimeout(() => utteranceElementsRef.current.get(utteranceId)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  const askAboutBubble = (id) => {
    const node = nodesRef.current.find((candidate) => candidate.id === id);
    if (!node) return;
    setDrawerOpen(true);
    setDrawerTab("conversation");
    setChatValue(`About “${nodeLabel(node)}”: `);
    window.setTimeout(() => chatInputRef.current?.focus(), 50);
  };

  const toggleFocus = () => {
    if (focusId) {
      setFocusId(null);
      showToast("Showing the full map");
    } else if (selectedId && !selectedId.startsWith("proposal-node-")) {
      setFocusId(selectedId);
      showToast("Focused this branch");
    } else {
      showToast("Select a committed bubble first");
    }
  };

  const openDrawer = (tab) => {
    if (drawerOpen && drawerTab === tab) setDrawerOpen(false);
    else {
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
    setSynthesizing(true);
    try {
      const result = await synthesizeSession(canonical.id, { expectedRevision: canonical.revision });
      setSynthesis(result?.synthesis ?? "No synthesis was returned.");
    } catch (error) {
      showToast(error.message);
    } finally {
      setSynthesizing(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      const target = event.target;
      const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
      if (event.key === "Escape") {
        if (marqueeActive) {
          setMarqueeActive(false);
          setSelectedIds([]);
          setSelectedId(null);
        }
        setComposer(null);
        setConnectFromId(null);
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
  const ghostVisuals = useMemo(() => proposalVisuals(pendingProposals, nodes), [pendingProposals, nodes]);
  const mapNodes = showSuggestions ? [...nodes, ...ghostVisuals.ghostNodes] : nodes;
  const mapEdges = showSuggestions ? [...edges, ...ghostVisuals.ghostEdges] : edges;
  const selected = mapNodes.find((node) => node.id === selectedId);
  const selectedSource = selected?.sources?.[0];
  const sourceUtterance = selectedSource
    ? canonical?.transcript?.find((utterance) => utterance.id === selectedSource.utteranceId)
    : null;
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
    conversation: { eyebrow: "Session", title: "Conversation", icon: IconMessageCircle },
    activity: { eyebrow: "Timeline", title: "Map activity", icon: IconClock },
    search: { eyebrow: "Find", title: "Search this map", icon: IconSearch },
    proposals: { eyebrow: "Partner", title: "Review proposals", icon: IconSparkles },
    layouts: { eyebrow: "One graph", title: "Switch the view", icon: IconHierarchy2 },
    overview: { eyebrow: "Working artifact", title: "Map overview", icon: IconGridDots },
    layers: { eyebrow: "Visibility", title: "Canvas layers", icon: IconStack2 },
    profile: { eyebrow: "Local profile", title: "MR", icon: IconUser },
    settings: { eyebrow: "Preferences", title: "Session settings", icon: IconSettings },
  };
  const presentation = drawerPresentation[drawerTab] ?? drawerPresentation.conversation;
  const DrawerIcon = presentation.icon;
  const timer = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const voiceConnected = realtimeRef.current?.connected;
  const voiceStarting = ["connecting", "requesting_microphone"].includes(voiceState);
  const committedNodeIds = new Set(canonical?.nodes?.map((node) => node.id) ?? []);
  const deletableSelection = selectedIds.filter((id) => id !== rootId && committedNodeIds.has(id));
  const historyEntryIds = [...(canonical?.operations ?? [])].reverse()
    .find((operation) => Array.isArray(operation.history_entry_ids))?.history_entry_ids ?? [];
  const canRedo = (canonical?.history_cursor ?? 0) < historyEntryIds.length;

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
    <main className="app-shell paper session-shell canonical-session-shell">
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
          setComposer({ mode: "edit", id });
          setComposerValue(nodeLabel(node));
        }}
        onAdd={(parentId) => { setComposer({ mode: "add", parentId }); setComposerValue(""); }}
        onAskAI={askAboutBubble}
        onArmConnect={(id) => setConnectFromId((current) => current === id ? null : id)}
        onConnectTarget={connectTarget}
        onSpawnFreeform={spawnFreeform}
        onDelete={deleteBubble}
        onAcceptGhost={acceptGhost}
        onDismissGhost={dismissGhost}
        onRemoveConnection={removeConnection}
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
        connectionPopQueueRef={connectionPopQueueRef}
      />

      {!nodes.length && !loading && (
        <div className="session-empty" aria-hidden="true">
          <IconSparkles />
          <p>Say what you're thinking.</p>
          <small>Complete thoughts become bubbles; the full transcript stays underneath.</small>
        </div>
      )}
      {loading && <div className="session-loading" role="status">Opening your map…</div>}

      <nav className="side-rail session-side-rail" aria-label="Workspace and session tools">
        <IconButton label="Maps" active={drawerOpen && drawerTab === "maps"} onClick={() => openDrawer("maps")} testId="maps-tool"><IconAffiliate /></IconButton>
        <IconButton label="Conversation" active={drawerOpen && drawerTab === "conversation"} onClick={() => openDrawer("conversation")} testId="conversation-tool"><IconMessageCircle /></IconButton>
        <IconButton label="Search" active={drawerOpen && drawerTab === "search"} onClick={() => openDrawer("search")} testId="search-tool"><IconSearch /></IconButton>
        <IconButton label={focusId ? "Show full map" : "Focus selected branch"} active={Boolean(focusId)} onClick={toggleFocus} testId="focus-tool"><IconFocusCentered /></IconButton>
        <IconButton label="Activity" active={drawerOpen && drawerTab === "activity"} onClick={() => openDrawer("activity")} testId="activity-tool"><IconClock /></IconButton>
        <IconButton label={favorite ? "Remove favorite" : "Add favorite"} pressed={favorite} onClick={() => setFavorite((value) => !value)} testId="favorite-tool"><IconStar /></IconButton>
        <IconButton label="Account" active={drawerOpen && drawerTab === "profile"} onClick={() => openDrawer("profile")} className="avatar-button rail-bottom" testId="profile-tool">MR</IconButton>
        <IconButton label="Settings" active={drawerOpen && drawerTab === "settings"} onClick={() => openDrawer("settings")} testId="settings-tool"><IconSettings /></IconButton>
      </nav>

      <div className="top-dock" aria-label="Canvas modes">
        <IconButton label="Rectangle select" active={marqueeActive} pressed={marqueeActive} onClick={() => { setMarqueeActive((value) => !value); setSelectedIds([]); setSelectedId(null); }} testId="marquee-tool"><IconMarquee /></IconButton>
        <IconButton label={`${pendingProposals.length} proposals waiting`} active={drawerOpen && drawerTab === "proposals"} onClick={() => openDrawer("proposals")} testId="ai-tool"><IconSparkles />{pendingProposals.length > 0 && <i className="tool-pip">{pendingProposals.length}</i>}</IconButton>
        <IconButton label="Switch graph view" active={drawerOpen && drawerTab === "layouts"} onClick={() => openDrawer("layouts")} testId="layout-tool"><IconAffiliate /></IconButton>
        <IconButton label="Map overview and synthesis" active={drawerOpen && drawerTab === "overview"} onClick={() => openDrawer("overview")} testId="overview-tool"><IconGridDots /></IconButton>
        <IconButton label="Layers" active={drawerOpen && drawerTab === "layers"} onClick={() => openDrawer("layers")} testId="layers-tool"><IconStack2 /></IconButton>
        <IconButton label="Canvas settings" active={drawerOpen && drawerTab === "settings"} onClick={() => openDrawer("settings")} testId="canvas-settings-tool"><IconSettings /></IconButton>
      </div>

      {marqueeActive && selectedIds.length > 0 && (
        <div className="selection-toolbar" role="toolbar" aria-label="Rectangle selection actions" data-testid="selection-toolbar">
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

          {(drawerTab === "conversation" || drawerTab === "activity") && (
            <div className="session-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={drawerTab === "conversation"} className={drawerTab === "conversation" ? "is-active" : ""} onClick={() => setDrawerTab("conversation")}>Conversation</button>
              <button type="button" role="tab" aria-selected={drawerTab === "activity"} className={drawerTab === "activity" ? "is-active" : ""} onClick={() => setDrawerTab("activity")}>Activity</button>
            </div>
          )}

          {drawerTab === "maps" ? (
            <div className="session-maps-panel">
              <button type="button" className="wide-action session-new-map" onClick={createNewMap}><IconPlus />New map</button>
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
                          <span><strong>{item.title}</strong><small>{item.thought_count ?? item.node_count ?? 0} thoughts · {formatUpdated(item.updated_at)}</small></span>
                          {item.id === canonical?.id && <IconCheck />}
                        </button>
                        <IconButton label="Rename map" onClick={() => { setRenameId(item.id); setRenameValue(item.title); }}><IconPencil /></IconButton>
                        <IconButton label="Delete map" className="danger-action" onClick={() => removeMap(item)}><IconTrash /></IconButton>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div className="panel-note"><IconEye /><span>Sessions are stored as local JSON and resume after restart.</span></div>
            </div>
          ) : drawerTab === "conversation" ? (
            <>
              <div className="session-transcript" data-testid="transcript">
                {!canonical?.transcript?.length && <p className="empty-state">The transcript is the record; the map is the interpretation. Start anywhere.</p>}
                {(canonical?.transcript ?? []).map((utterance) => (
                  <div key={utterance.id} ref={(element) => { if (element) utteranceElementsRef.current.set(utterance.id, element); else utteranceElementsRef.current.delete(utterance.id); }} className={`session-utterance ${utterance.speaker} ${highlight?.utteranceId === utterance.id ? "is-highlighted" : ""}`}>
                    <span>{utterance.speaker === "you" ? "You" : "Partner"} · {formatClock(utterance.completed_at)}</span>
                    <p>{renderUtteranceText(utterance)}</p>
                  </div>
                ))}
                <div ref={transcriptEndRef} />
              </div>
              <form className="session-chat" onSubmit={submitChat}>
                <input ref={chatInputRef} value={chatValue} onChange={(event) => setChatValue(event.target.value)} placeholder={voiceConnected ? "Type into the live conversation…" : "Type a complete thought…"} />
                <IconButton type="submit" label="Send" disabled={!chatValue.trim() || busy}><IconSend /></IconButton>
              </form>
            </>
          ) : drawerTab === "activity" ? (
            <>
              <div className="history-actions">
                <IconButton label="Undo map change" onClick={undo} disabled={!canonical?.history_cursor}><IconArrowBackUp /></IconButton>
                <IconButton label="Redo map change" onClick={redo} disabled={!canRedo}><IconArrowForwardUp /></IconButton>
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
              <label className="search-field"><IconSearch /><input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search thoughts…" /></label>
              <div className="panel-list search-results">
                {searchResults.map((node) => <button type="button" key={node.id} onClick={() => { selectOne(node.id); setDrawerOpen(false); }}><span>{nodeLabel(node)}</span></button>)}
                {!searchResults.length && <p className="empty-state">No matching thoughts yet.</p>}
              </div>
            </div>
          ) : drawerTab === "proposals" ? (
            <div className="session-panel-copy">
              <p>{pendingProposals.length ? `${pendingProposals.length} Partner ${pendingProposals.length === 1 ? "proposal" : "proposals"} are visible on the canvas.` : "No proposals are waiting for review."}</p>
              <label className="session-setting-row"><span><strong>Show proposals</strong><small>Ghost tethers and review cards</small></span><input type="checkbox" checked={showSuggestions} onChange={(event) => setShowSuggestions(event.target.checked)} /></label>
            </div>
          ) : drawerTab === "layouts" ? (
            <div className="session-panel-copy">
              <div className="segmented-control" aria-label="Graph layout">
                <button type="button" className={viewMode === "clusters" ? "is-active" : ""} onClick={() => changeView("clusters")}>Clusters</button>
                <button type="button" className={viewMode === "hierarchy" ? "is-active" : ""} onClick={() => changeView("hierarchy")}>Hierarchy</button>
              </div>
              <p className="panel-description">Two views of the same canonical graph. Cluster mode keeps the fluid physics active.</p>
            </div>
          ) : drawerTab === "overview" ? (
            <div className="session-panel-copy">
              <div className="map-stats"><span><strong>{canonical?.nodes?.length ?? 0}</strong><small>Thoughts</small></span><span><strong>{canonical?.edges?.length ?? 0}</strong><small>Links</small></span><span><strong>{pendingProposals.length}</strong><small>Proposals</small></span></div>
              <button type="button" className="wide-action" disabled={synthesizing || !canonical?.nodes?.length} onClick={requestSynthesis}><IconSparkles />{synthesizing ? "Synthesizing…" : "Write a synthesis"}</button>
              {synthesis && <div className="session-synthesis"><p>{synthesis}</p></div>}
            </div>
          ) : drawerTab === "layers" ? (
            <div className="session-settings-panel">
              <label className="session-setting-row"><span><strong>Partner proposals</strong><small>Show ghost branches and tethers</small></span><input type="checkbox" checked={showSuggestions} onChange={(event) => setShowSuggestions(event.target.checked)} /></label>
              <label className="session-setting-row"><span><strong>Provenance labels</strong><small>Reveal transcript-source labels on bubbles</small></span><input type="checkbox" checked={showProvenance} onChange={(event) => setShowProvenance(event.target.checked)} /></label>
            </div>
          ) : drawerTab === "profile" ? (
            <div className="session-profile-panel"><div className="profile-card"><span>MR</span><div><strong>Solo workspace</strong><small>Private by default</small></div></div><div className="panel-note"><IconUser /><span>The transcript and accepted map stay together in this local session.</span></div></div>
          ) : (
            <div className="session-settings-panel">
              <div className="session-voice-mode"><span><strong>Voice turn-taking</strong><small>Changing modes disconnects the current call.</small></span><div className="segmented-control"><button type="button" className={voiceMode === "vad" ? "is-active" : ""} onClick={() => setNextVoiceMode("vad")}>Automatic</button><button type="button" className={voiceMode === "push-to-talk" ? "is-active" : ""} onClick={() => setNextVoiceMode("push-to-talk")}>Push to talk</button></div></div>
              <label className="session-setting-row"><span><strong>Reduced motion</strong><small>Freeze deformation cues and reveal connections immediately</small></span><input type="checkbox" checked={reducedMotion} onChange={(event) => setReducedMotion(event.target.checked)} /></label>
              <label className="session-setting-row"><span><strong>Partner proposals</strong><small>Show reviewable ghost suggestions</small></span><input type="checkbox" checked={showSuggestions} onChange={(event) => setShowSuggestions(event.target.checked)} /></label>
            </div>
          )}
        </aside>
      )}

      {selected && sourceUtterance && (
        <div className="session-provenance" data-testid="provenance-chip"><IconQuote /><p>“…{sourceUtterance.text.slice(selectedSource.span[0], selectedSource.span[1])}…”</p><button type="button" onClick={() => openEvidence(sourceUtterance.id, selected.id)}>Show in transcript</button></div>
      )}

      {showSuggestions && <div className="session-proposals">
        {pendingProposals.map((proposal) => (
          <article key={proposal.id} className={`session-proposal ${proposal.status === "stale" ? "is-stale" : ""}`} data-testid="partner-proposal">
            <header><i className="session-proposal-mark"><IconSparkles /></i><span>Partner suggests</span></header>
            <p>{proposal.rationale}</p>
            <small className="session-proposal-stale">Source map revision {proposal.base_revision}{proposal.base_revision !== canonical?.revision ? " — re-checked on accept" : ""}</small>
            <div className="session-proposal-operations">
              {(proposal.operations ?? []).map((operation) => (
                <div key={operation.id} className={operation.excluded ? "is-excluded" : ""}><span>{proposalOperationLabel(operation)}</span>{proposal.status === "pending" && !operation.excluded && <IconButton label="Exclude this change" onClick={() => excludeProposalOperation(proposal, operation)}><IconX /></IconButton>}</div>
              ))}
            </div>
            <footer>
              <IconButton label="Accept AI suggestion" className="session-accept" disabled={proposal.status === "stale" || !(proposal.operations ?? []).some((operation) => !operation.excluded)} onClick={() => acceptProposal(proposal)} testId="accept-suggestion"><IconCheck /></IconButton>
              <IconButton label="Dismiss AI suggestion" className="session-dismiss" onClick={() => dismissProposal(proposal)} testId="dismiss-suggestion"><IconX /></IconButton>
              {(proposal.evidence ?? []).slice(0, 2).map((evidence, index) => {
                const utteranceId = evidence.utterance_id ?? (typeof evidence === "string" ? evidence : null);
                const spans = Number.isInteger(evidence?.start) && Number.isInteger(evidence?.end)
                  ? [[evidence.start, evidence.end]]
                  : null;
                const label = evidence.quote ? `“${evidence.quote}”` : "Transcript source";
                return utteranceId ? <button key={`${utteranceId}-${index}`} type="button" className="session-evidence" onClick={() => openEvidence(utteranceId, null, spans)}><IconQuote />{label}</button> : null;
              })}
            </footer>
          </article>
        ))}
      </div>}

      {composer && (
        <form className="session-composer" onSubmit={submitComposer}>
          <label><span>{composer.mode === "edit" ? "Rewrite this bubble" : "Add a thought"}</span><textarea autoFocus rows="3" value={composerValue} onChange={(event) => setComposerValue(event.target.value)} placeholder="Keep it concise; the transcript keeps the rest" /></label>
          <div><IconButton label="Cancel" onClick={() => setComposer(null)}><IconX /></IconButton><IconButton type="submit" label={composer.mode === "edit" ? "Save label" : "Add bubble"} disabled={!composerValue.trim()}><IconCheck /></IconButton></div>
        </form>
      )}

      {(voiceStarting || voiceConnected || liveCaption || partnerCaption) && (
        <div className="voice-caption session-caption" role="status" aria-live="polite"><span /><p>{partnerCaption ? "Partner" : voiceStarting ? "Connecting securely…" : voiceMode === "push-to-talk" ? "Hold the mic while you speak…" : "Listening for a complete thought…"}</p><small>{partnerCaption || liveCaption || "Partial speech stays here until the utterance completes."}</small></div>
      )}

      <div className={`voice-control ${voiceConnected ? "is-listening" : ""}`}>
        <span className="voice-timer">{timer}</span>
        {voiceMode === "push-to-talk" && voiceConnected ? (
          <button type="button" className="icon-button" aria-label="Hold to talk" title="Hold to talk" onPointerDown={startPushToTalk} onPointerUp={stopPushToTalk} onPointerCancel={stopPushToTalk}><IconMicrophone /></button>
        ) : (
          <IconButton label={voiceConnected || voiceStarting ? "Stop voice conversation" : "Start voice conversation"} pressed={voiceConnected} onClick={toggleVoice} testId="voice-control"><IconMicrophone /></IconButton>
        )}
        {voiceMode === "push-to-talk" && voiceConnected && <IconButton label="Disconnect voice" onClick={stopRealtime}><IconX /></IconButton>}
      </div>
      {voiceError && <div className="session-voice-error" role="status">{voiceError} <button type="button" onClick={() => setVoiceError("")}>Dismiss</button></div>}

      <div className="zoom-controls" aria-label="Canvas zoom"><IconButton label="Center map" onClick={() => { setPan({ x: 0, y: 0 }); setZoom(1); }}><IconFocusCentered /></IconButton><IconButton label="Zoom out" onClick={() => setZoom((value) => clamp(value - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))}><IconMinus /></IconButton><span>{Math.round(zoom * 100)}%</span><IconButton label="Zoom in" onClick={() => setZoom((value) => clamp(value + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))}><IconPlus /></IconButton></div>
      {connectFromId && <div className="connect-hint" role="status"><span>Select another bubble to connect</span><IconButton label="Cancel connection" onClick={() => setConnectFromId(null)}><IconX /></IconButton></div>}
      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </main>
  );
}
