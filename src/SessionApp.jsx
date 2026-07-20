// Conversation-first Thoughtform session ("?mode=session").
//
// The map and the conversation are one system: you talk (or type), complete
// thoughts condense into concise bubbles with exact transcript provenance,
// a simulated realtime partner keeps the exchange moving, and a background
// curator proposes structure as ghost tethers that must be accepted or
// dismissed. The transcript is the lossless record; bubbles are
// interpretations sized by semantic weight (see session/sizing.js).
//
// Model calls are intentionally simulated at three seams — partnerReply
// (realtime layer), condenseUtterance (label writer), runCurator (background
// curator) — each with the contract a real backend would keep.

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconCheck,
  IconClock,
  IconMessageCircle,
  IconMicrophone,
  IconQuote,
  IconSearch,
  IconSend,
  IconSettings,
  IconSparkles,
  IconStar,
  IconUser,
  IconFocusCentered,
  IconMinus,
  IconPlus,
  IconX,
} from "@tabler/icons-react";
import { IconButton, MindMap } from "./App.jsx";
import { BASE_HEIGHT, BASE_WIDTH } from "./mapData.js";
import {
  FLUID_PHYSICS_SETTINGS,
  captureFluidRestLengths,
  stepFluidPhysics,
} from "./fluidPhysics.js";
import {
  CONNECTION_CREATE_CONTACT_PROGRESS,
  CONNECTION_CREATE_DURATION,
  CONNECTION_CREATE_RETURN_DELAY,
  clamp,
  findGrowthPlacement,
  withWobble,
} from "./fluidMaterial.js";
import { bubbleLines, bubbleTargetRadius, updateBubbleRadii } from "./session/sizing.js";
import { condenseUtterance, informativeTokens, overlapScore } from "./session/condense.js";
import { DICTATIONS, partnerReply } from "./session/agent.js";
import { rebaseProposal, runCurator } from "./session/curator.js";

const MIN_ZOOM = 0.72;
const MAX_ZOOM = 1.36;
const ZOOM_STEP = 0.08;
const DICTATION_WORD_MS = 240;
const CURATOR_UTTERANCE_INTERVAL = 2;
const REMENTION_MIN_OVERLAP = 2;
const REMENTION_COVERAGE = 0.6;
const ATTACH_MIN_OVERLAP = 1;
const HISTORY_LIMIT = 14;

function timeStamp() {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date());
}

function cloneNodes(nodes) {
  return nodes.map((node) => ({ ...node, sources: node.sources ? [...node.sources] : undefined }));
}

function cloneEdges(edges) {
  return edges.map((edge) => ({ ...edge }));
}

function bubbleLabel(node) {
  return node?.lines?.join(" ") ?? "Thought";
}

export function SessionApp() {
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const revRef = useRef(0);
  const counterRef = useRef(0);
  const anchorIdRef = useRef(null);
  const unplacedCountRef = useRef(0);

  const [transcript, setTranscript] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [proposals, setProposals] = useState([]);
  const historyRef = useRef({
    entries: [{ actor: "you", label: "Started a session", nodes: [], edges: [], at: "" }],
    index: 0,
  });
  const [historyView, setHistoryView] = useState(historyRef.current);
  const utterancesSinceCuratorRef = useRef(0);
  const curatorBusyRef = useRef(false);
  const turnRef = useRef(0);

  const [selectedId, setSelectedId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [connectFromId, setConnectFromId] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerTab, setDrawerTab] = useState("conversation");
  const [searchQuery, setSearchQuery] = useState("");
  const [favorite, setFavorite] = useState(true);
  const [focusId, setFocusId] = useState(null);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [chatValue, setChatValue] = useState("");
  const [composer, setComposer] = useState(null);
  const [composerValue, setComposerValue] = useState("");
  const [highlight, setHighlight] = useState(null);
  const [listening, setListening] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [liveCaption, setLiveCaption] = useState("");
  const [toast, setToast] = useState("");
  const dictationRef = useRef(null);
  const dictationIndexRef = useRef(0);
  const utteranceElementsRef = useRef(new Map());
  const transcriptEndRef = useRef(null);
  const chatInputRef = useRef(null);

  const showToast = (message) => setToast(message);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selectOne = (id) => {
    setSelectedId(id);
    setSelectedIds(id ? [id] : []);
  };

  const appendLedger = (actor, label) => {
    setLedger((entries) => [...entries, { id: `op-${entries.length + 1}`, actor, label, at: timeStamp() }]);
  };

  const appendUtterance = (speaker, text) => {
    const id = `u-${counterRef.current += 1}`;
    setTranscript((entries) => [...entries, { id, speaker, text, at: timeStamp() }]);
    return id;
  };

  // Physics and graph actions are the sole writers of nodesRef/edgesRef;
  // React state is the rendered mirror (see AGENTS.md / design-qa iteration 9).
  // History lives in a ref so graph actions fired from timers (dictation,
  // curator resolution) never fold in a stale snapshot list.
  const applyGraph = (nextNodes, nextEdges, entry) => {
    const physicsEdges = captureFluidRestLengths(nextNodes, nextEdges, {});
    nodesRef.current = nextNodes;
    edgesRef.current = physicsEdges;
    revRef.current += 1;
    setNodes(nextNodes);
    setEdges(physicsEdges);
    if (entry) {
      appendLedger(entry.actor, entry.label);
      const current = historyRef.current;
      const entries = [
        ...current.entries.slice(0, current.index + 1),
        {
          actor: entry.actor,
          label: entry.label,
          nodes: cloneNodes(nextNodes),
          edges: cloneEdges(physicsEdges),
          at: timeStamp(),
        },
      ].slice(-HISTORY_LIMIT);
      historyRef.current = { entries, index: entries.length - 1 };
      setHistoryView(historyRef.current);
    }
  };

  // Presentation-only updates (heat, wobble) skip history but still go
  // through the graph-action writer path.
  const touchGraph = (nextNodes) => {
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
  };

  const restoreHistory = (index) => {
    const snapshot = historyRef.current.entries[index];
    if (!snapshot) return;
    const nextNodes = cloneNodes(snapshot.nodes);
    const nextEdges = captureFluidRestLengths(nextNodes, cloneEdges(snapshot.edges), {});
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    revRef.current += 1;
    setNodes(nextNodes);
    setEdges(nextEdges);
    historyRef.current = { ...historyRef.current, index };
    setHistoryView(historyRef.current);
    if (!nextNodes.some((node) => node.id === selectedId)) selectOne(null);
    showToast(snapshot.label || "Back to the empty canvas");
  };

  const undo = () => {
    if (historyRef.current.index <= 0) return;
    const undone = historyRef.current.entries[historyRef.current.index];
    restoreHistory(historyRef.current.index - 1);
    appendLedger("you", `Undid “${undone.label}”`);
  };
  const redo = () => {
    if (historyRef.current.index < historyRef.current.entries.length - 1) {
      const redone = historyRef.current.entries[historyRef.current.index + 1];
      restoreHistory(historyRef.current.index + 1);
      appendLedger("you", `Redid “${redone.label}”`);
    }
  };

  useEffect(() => {
    let animationFrame;
    let lastTime = performance.now();
    const animatePhysics = (now) => {
      const frameStep = clamp((now - lastTime) / 16.67, 0.35, 2);
      lastTime = now;
      const result = stepFluidPhysics(nodesRef.current, edgesRef.current, {
        frameStep,
        width: BASE_WIDTH,
        height: BASE_HEIGHT,
        settings: FLUID_PHYSICS_SETTINGS,
      });
      const radiusActive = updateBubbleRadii(result.nodes, edgesRef.current, now, frameStep);
      if (result.active || radiusActive) {
        nodesRef.current = result.nodes;
        setNodes(result.nodes);
      }
      animationFrame = window.requestAnimationFrame(animatePhysics);
    };
    animationFrame = window.requestAnimationFrame(animatePhysics);
    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => {
    if (!listening) return undefined;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [listening]);

  const makeBubble = (label, { parent, sources, provenance, nodeList, linkList }) => {
    const id = `b-${counterRef.current += 1}`;
    const lines = bubbleLines(label);
    const committed = nodeList.filter((node) => !node.ghost);
    const anchorAlive = committed.find((node) => node.id === anchorIdRef.current)
      ?? committed[0];
    const isFirst = !anchorAlive;
    const depth = isFirst ? 0 : (parent ? clamp((parent.depth ?? 0) + 1, 1, 4) : 2);
    const draft = { depth, lines, heatAt: performance.now() };
    const radius = bubbleTargetRadius(draft, parent ? 1 : 0, performance.now());
    let x;
    let y;
    if (isFirst) {
      x = BASE_WIDTH * 0.33;
      y = BASE_HEIGHT * 0.5;
      anchorIdRef.current = id;
    } else if (parent) {
      const placement = findGrowthPlacement(parent, radius, nodeList, linkList, BASE_WIDTH, BASE_HEIGHT);
      x = placement.x;
      y = placement.y;
    } else {
      // Unplaced idea: park it on the anchor's periphery; the curator will
      // propose a home with evidence rather than the app guessing one.
      const angle = -0.9 + (unplacedCountRef.current += 1) * 2.4;
      const distance = anchorAlive.r + 240;
      x = clamp(anchorAlive.x + Math.cos(angle) * distance, radius + 24, BASE_WIDTH - radius - 24);
      y = clamp(anchorAlive.y + Math.sin(angle) * distance, radius + 24, BASE_HEIGHT - radius - 24);
    }
    return {
      id,
      x,
      y,
      r: radius,
      targetR: radius,
      depth,
      lines,
      sources,
      provenance,
      heatAt: performance.now(),
      createdAt: performance.now(),
      vx: 0,
      vy: 0,
    };
  };

  const handleUserUtterance = (rawText, origin) => {
    const text = rawText.trim();
    if (!text) return;
    const utteranceId = appendUtterance("you", text);
    const ideas = condenseUtterance(text);
    const bubbleTokens = new Map(
      nodesRef.current
        .filter((node) => !node.ghost)
        .map((node) => [node.id, informativeTokens(bubbleLabel(node))]),
    );

    const now = performance.now();
    const revisited = [];
    const created = [];
    let nextNodes = nodesRef.current;
    let nextEdges = edgesRef.current;

    ideas.forEach((idea) => {
      let bestId = null;
      let bestScore = 0;
      bubbleTokens.forEach((tokens, id) => {
        const score = overlapScore(idea.tokens, tokens);
        if (score > bestScore) { bestScore = score; bestId = id; }
      });
      const best = nextNodes.find((node) => node.id === bestId);
      if (best && bestScore >= REMENTION_MIN_OVERLAP
        && bestScore / Math.max(idea.tokens.size, 1) >= REMENTION_COVERAGE) {
        // The conversation came back to an existing bubble: warm it up and
        // let sizing translate that attention into weight — no duplicate.
        revisited.push(bubbleLabel(best));
        nextNodes = nextNodes.map((node) => (
          node.id === best.id
            ? withWobble({ ...node, heatAt: now, sources: [...(node.sources ?? []), { utteranceId, span: idea.span }] }, 1, 0.4, 0.07, { startAt: now })
            : node
        ));
        return;
      }
      const parent = best && bestScore >= ATTACH_MIN_OVERLAP ? best : null;
      const bubble = makeBubble(idea.label, {
        parent,
        sources: [{ utteranceId, span: idea.span }],
        provenance: origin === "voice" ? "Voice · condensed" : "Chat · condensed",
        nodeList: nextNodes,
        linkList: nextEdges,
      });
      nextNodes = [...nextNodes, bubble];
      if (parent) {
        nextEdges = [...nextEdges, { from: parent.id, to: bubble.id, bend: 0, createdAt: bubble.createdAt }];
      }
      bubbleTokens.set(bubble.id, idea.tokens);
      created.push(bubble);
    });

    if (created.length) {
      const label = created.length === 1
        ? `Captured “${bubbleLabel(created[0])}”`
        : `Captured ${created.length} ideas`;
      applyGraph(nextNodes, nextEdges, { actor: "partner", label });
      selectOne(created[created.length - 1].id);
    } else if (revisited.length) {
      const label = revisited.length === 1
        ? `Revisited “${revisited[0]}”`
        : `Revisited ${revisited.length} ideas`;
      applyGraph(nextNodes, nextEdges, { actor: "partner", label });
    }

    turnRef.current += 1;
    const reply = partnerReply({ ideas, revisited, turn: turnRef.current });
    window.setTimeout(() => appendUtterance("partner", reply), 700);

    utterancesSinceCuratorRef.current += 1;
    if (utterancesSinceCuratorRef.current >= CURATOR_UTTERANCE_INTERVAL && !curatorBusyRef.current) {
      utterancesSinceCuratorRef.current = 0;
      curatorBusyRef.current = true;
      runCurator({ nodes: nodesRef.current, edges: edgesRef.current, rev: revRef.current })
        .then((proposal) => {
          curatorBusyRef.current = false;
          if (!proposal) return;
          setProposals((pending) => [...pending, proposal]);
          appendLedger("curator", `Proposed ${proposal.ops.length} ${proposal.ops.length === 1 ? "change" : "changes"} for review`);
        });
    }
  };

  const submitChat = (event) => {
    event.preventDefault();
    const value = chatValue.trim();
    if (!value) return;
    setChatValue("");
    handleUserUtterance(value, "chat");
  };

  const stopDictation = (commit) => {
    const dictation = dictationRef.current;
    if (!dictation) return;
    window.clearInterval(dictation.timer);
    dictationRef.current = null;
    setListening(false);
    setLiveCaption("");
    if (commit && dictation.index > 0) {
      handleUserUtterance(dictation.words.slice(0, dictation.index).join(" "), "voice");
    }
  };

  const toggleVoice = () => {
    if (listening) {
      stopDictation(true);
      return;
    }
    const text = DICTATIONS[dictationIndexRef.current % DICTATIONS.length];
    dictationIndexRef.current += 1;
    const words = text.split(/\s+/);
    setSeconds(0);
    setListening(true);
    showToast("Listening — bubbles form when the thought completes");
    const dictation = { words, index: 0, timer: 0 };
    dictation.timer = window.setInterval(() => {
      dictation.index += 1;
      setLiveCaption(words.slice(0, dictation.index).join(" "));
      if (dictation.index >= words.length) {
        stopDictation(true);
      }
    }, DICTATION_WORD_MS);
    dictationRef.current = dictation;
  };

  const connectEdgeWithMotion = (currentNodes, currentEdges, source, target, createdAt) => {
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const targetImpactAt = createdAt + CONNECTION_CREATE_DURATION * CONNECTION_CREATE_CONTACT_PROGRESS;
    const sourceReturnAt = targetImpactAt + CONNECTION_CREATE_RETURN_DELAY;
    return currentNodes.map((node) => {
      if (node.id === source.id) {
        const launched = withWobble(node, dx, dy, 0.064, { startAt: createdAt, travel: 0.14 });
        return withWobble(launched, -dx, -dy, 0.038, { startAt: sourceReturnAt, travel: 0.11, append: true });
      }
      if (node.id === target.id) {
        // A previously unplaced bubble adopts its new parent's tier — but the
        // anchor is never unplaced; connections may point into it freely.
        const hadEdge = currentEdges.some((edge) => !edge.ghost && (edge.from === node.id || edge.to === node.id));
        const adopted = node.id !== anchorIdRef.current && (!hadEdge || (node.depth ?? 2) > (source.depth ?? 0) + 1)
          ? { ...node, depth: clamp((source.depth ?? 0) + 1, 1, 4) }
          : node;
        // Surface tension anticipates contact: the target leans faintly
        // toward the incoming head just before impact.
        const anticipated = withWobble(adopted, dx, dy, -0.034, { startAt: targetImpactAt - 120, travel: 0.1 });
        return withWobble(anticipated, dx, dy, 0.105, { startAt: targetImpactAt, travel: 0.32, append: true });
      }
      return node;
    });
  };

  const connectTarget = (targetId) => {
    if (!connectFromId || connectFromId === targetId) return;
    const source = nodesRef.current.find((node) => node.id === connectFromId);
    const target = nodesRef.current.find((node) => node.id === targetId);
    if (!source || !target) { setConnectFromId(null); return; }
    const exists = edgesRef.current.some((edge) => (
      (edge.from === connectFromId && edge.to === targetId)
      || (edge.from === targetId && edge.to === connectFromId)
    ));
    if (exists) {
      setConnectFromId(null);
      showToast("Those thoughts are already connected");
      return;
    }
    const createdAt = performance.now();
    const nextNodes = connectEdgeWithMotion(nodesRef.current, edgesRef.current, source, target, createdAt);
    const nextEdges = [...edgesRef.current, { from: connectFromId, to: targetId, bend: 0, createdAt }];
    applyGraph(nextNodes, nextEdges, { actor: "you", label: "Connected two thoughts" });
    setConnectFromId(null);
    selectOne(targetId);
  };

  const removeConnection = (targetEdge, motion = {}) => {
    const source = nodesRef.current.find((node) => node.id === targetEdge.from);
    const target = nodesRef.current.find((node) => node.id === targetEdge.to);
    if (!source || !target) return;
    const hitT = clamp(motion.hitT ?? 0.5, 0, 1);
    const hitX = source.x + (target.x - source.x) * hitT;
    const hitY = source.y + (target.y - source.y) * hitT;
    const matches = (edge) => (
      (edge.from === targetEdge.from && edge.to === targetEdge.to)
      || (edge.from === targetEdge.to && edge.to === targetEdge.from)
    );
    const nextEdges = edgesRef.current.filter((edge) => !matches(edge));
    const nextNodes = nodesRef.current.map((node) => {
      if (node.id === source.id) return withWobble(node, source.x - hitX, source.y - hitY, 0.046 + (1 - hitT) * 0.02, { startAt: motion.sourceImpactAt, travel: 0.13 });
      if (node.id === target.id) return withWobble(node, target.x - hitX, target.y - hitY, 0.046 + hitT * 0.02, { startAt: motion.targetImpactAt, travel: 0.13 });
      return node;
    });
    applyGraph(nextNodes, nextEdges, { actor: "you", label: "Popped a connection" });
    setConnectFromId(null);
  };

  const acceptProposal = (proposal) => {
    const ops = rebaseProposal(proposal, nodesRef.current, edgesRef.current);
    setProposals((pending) => pending.filter((candidate) => candidate.id !== proposal.id));
    if (!ops.length) {
      appendLedger("curator", "Proposal was stale — dropped");
      showToast("The map moved on — that proposal no longer applies");
      return;
    }
    let nextNodes = nodesRef.current;
    let nextEdges = edgesRef.current;
    const now = performance.now();
    ops.forEach((op, index) => {
      const source = nextNodes.find((node) => node.id === op.from);
      const target = nextNodes.find((node) => node.id === op.to);
      if (!source || !target) return;
      // Stagger multi-op batches so each growth reads as its own event.
      const createdAt = now + index * 160;
      nextNodes = connectEdgeWithMotion(nextNodes, nextEdges, source, target, createdAt);
      nextEdges = [...nextEdges, { from: op.from, to: op.to, bend: 0, createdAt }];
    });
    applyGraph(nextNodes, nextEdges, {
      actor: "curator",
      label: `Applied partner proposal (${ops.length} ${ops.length === 1 ? "link" : "links"})`,
    });
    if (ops.length < proposal.ops.length) showToast("Applied what still fit — the rest was stale");
  };

  const dismissProposal = (proposal) => {
    setProposals((pending) => pending.filter((candidate) => candidate.id !== proposal.id));
    appendLedger("you", "Declined a partner proposal");
  };

  const openEvidence = (utteranceId, nodeId = null) => {
    setDrawerOpen(true);
    setDrawerTab("conversation");
    setHighlight({ utteranceId, nodeId });
  };

  useEffect(() => {
    if (!highlight) return;
    const element = utteranceElementsRef.current.get(highlight.utteranceId);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlight]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript]);

  const deleteBubble = (id) => {
    if (id === anchorIdRef.current) {
      showToast("The starting thought anchors this map");
      return;
    }
    const removed = nodesRef.current.find((node) => node.id === id);
    const nextNodes = nodesRef.current.filter((node) => node.id !== id);
    const nextEdges = edgesRef.current.filter((edge) => edge.from !== id && edge.to !== id);
    applyGraph(nextNodes, nextEdges, { actor: "you", label: `Removed “${bubbleLabel(removed)}”` });
    selectOne(null);
  };

  const submitComposer = (event) => {
    event.preventDefault();
    const value = composerValue.trim();
    if (!value || !composer) return;
    if (composer.mode === "edit") {
      const lines = bubbleLines(value);
      const next = nodesRef.current.map((node) => (
        node.id === composer.id ? { ...node, lines, edited: true } : node
      ));
      applyGraph(next, edgesRef.current, { actor: "you", label: "Edited a bubble label" });
      selectOne(composer.id);
    } else {
      const parent = nodesRef.current.find((node) => node.id === composer.parentId) ?? null;
      const bubble = makeBubble(value, {
        parent,
        sources: [],
        provenance: "Added by you",
        nodeList: nodesRef.current,
        linkList: edgesRef.current,
      });
      const nextNodes = [...nodesRef.current, bubble];
      const nextEdges = parent
        ? [...edgesRef.current, { from: parent.id, to: bubble.id, bend: 0, createdAt: bubble.createdAt }]
        : edgesRef.current;
      applyGraph(nextNodes, nextEdges, { actor: "you", label: `Added “${bubbleLabel(bubble)}”` });
      selectOne(bubble.id);
    }
    setComposer(null);
    setComposerValue("");
  };

  const spawnFreeform = (x, y) => {
    const bubble = makeBubble("New thought", {
      parent: null,
      sources: [],
      provenance: "Added by you",
      nodeList: nodesRef.current,
      linkList: edgesRef.current,
    });
    const radius = bubble.r;
    const placed = {
      ...bubble,
      x: clamp(x, radius + 20, BASE_WIDTH - radius - 20),
      y: clamp(y, radius + 20, BASE_HEIGHT - radius - 20),
    };
    applyGraph([...nodesRef.current, placed], edgesRef.current, { actor: "you", label: "Added a freeform thought" });
    selectOne(placed.id);
  };

  const startMoveNode = (id) => {
    touchGraph(nodesRef.current.map((node) => node.id === id
      ? { ...node, dragging: true, vx: 0, vy: 0, shadeVx: 0, shadeVy: 0 }
      : node));
  };

  const moveNode = (id, x, y) => {
    touchGraph(nodesRef.current.map((node) => node.id === id
      ? { ...node, x, y, dragging: true, vx: 0, vy: 0, shadeVx: x - node.x, shadeVy: y - node.y }
      : node));
  };

  const finishMoveNode = (id, vx, vy, moved) => {
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
    if (moved) {
      applyGraph(next, edgesRef.current, {
        actor: "you",
        label: `Moved “${bubbleLabel(next.find((node) => node.id === id))}”`,
      });
    } else {
      touchGraph(next);
    }
  };

  const cancelMoveNode = (id) => {
    touchGraph(nodesRef.current.map((node) => node.id === id
      ? { ...node, dragging: false, vx: 0, vy: 0, shadeVx: 0, shadeVy: 0 }
      : node));
  };

  const askAboutBubble = (id) => {
    const node = nodesRef.current.find((candidate) => candidate.id === id);
    if (!node) return;
    setDrawerOpen(true);
    setDrawerTab("conversation");
    setChatValue(`About “${bubbleLabel(node)}”: `);
    window.setTimeout(() => chatInputRef.current?.focus(), 60);
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      const target = event.target;
      const editingText = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target.isContentEditable;
      if (event.key === "Escape") {
        setComposer(null);
        setConnectFromId(null);
        setHighlight(null);
      }
      if (!editingText && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const proposalGhostEdges = useMemo(() => (
    proposals.flatMap((proposal) => proposal.ops.map((op) => ({
      from: op.from,
      to: op.to,
      bend: 14,
      ghost: true,
    })))
  ), [proposals]);

  const edgesForMap = useMemo(
    () => [...edges, ...proposalGhostEdges],
    [edges, proposalGhostEdges],
  );

  const selected = nodes.find((node) => node.id === selectedId);
  const selectedSource = selected?.sources?.[0];
  const sourceUtterance = selectedSource
    ? transcript.find((utterance) => utterance.id === selectedSource.utteranceId)
    : null;

  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return nodes.slice(0, 12);
    return nodes.filter((node) => bubbleLabel(node).toLowerCase().includes(query)).slice(0, 12);
  }, [nodes, searchQuery]);

  const openDrawer = (tabName) => {
    if (drawerOpen && drawerTab === tabName) setDrawerOpen(false);
    else {
      setDrawerOpen(true);
      setDrawerTab(tabName);
    }
  };

  const toggleFocus = () => {
    if (focusId) {
      setFocusId(null);
      showToast("Showing the full map");
      return;
    }
    if (!selected || selected.ghost) {
      showToast("Select a committed bubble to focus its branch");
      return;
    }
    setFocusId(selected.id);
    showToast("Focused this branch");
  };

  const renderUtteranceText = (utterance) => {
    if (highlight?.utteranceId !== utterance.id) return utterance.text;
    const provenanceNode = highlight.nodeId
      ? nodes.find((node) => node.id === highlight.nodeId)
      : null;
    const spans = (provenanceNode?.sources ?? [])
      .filter((sourceRef) => sourceRef.utteranceId === utterance.id)
      .map((sourceRef) => sourceRef.span)
      .sort((a, b) => a[0] - b[0]);
    if (!spans.length) return utterance.text;
    const parts = [];
    let cursor = 0;
    spans.forEach((span, index) => {
      if (span[0] > cursor) parts.push(utterance.text.slice(cursor, span[0]));
      parts.push(<mark key={index}>{utterance.text.slice(Math.max(span[0], cursor), span[1])}</mark>);
      cursor = Math.max(cursor, span[1]);
    });
    parts.push(utterance.text.slice(cursor));
    return parts;
  };

  const timer = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const historyEntries = historyView.entries;
  const historyIndex = historyView.index;
  const drawerPresentation = {
    conversation: { eyebrow: "Session", title: "Conversation", icon: IconMessageCircle },
    activity: { eyebrow: "Timeline", title: "Map activity", icon: IconClock },
    search: { eyebrow: "Find", title: "Search this map", icon: IconSearch },
    profile: { eyebrow: "Local profile", title: "MR", icon: IconUser },
    settings: { eyebrow: "Preferences", title: "Session settings", icon: IconSettings },
  }[drawerTab] ?? { eyebrow: "Session", title: "Conversation", icon: IconMessageCircle };
  const DrawerIcon = drawerPresentation.icon;

  return (
    <main className="app-shell paper session-shell">
      <MindMap
        concept="paper"
        nodes={nodes}
        edges={edgesForMap}
        selectedId={selectedId}
        selectedIds={selectedIds}
        onSelect={selectOne}
        onSelectMany={(ids) => setSelectedIds(ids)}
        onMoveStart={startMoveNode}
        onMoveNode={moveNode}
        onMoveEnd={finishMoveNode}
        onMoveCancel={cancelMoveNode}
        onEdit={(id) => {
          const node = nodesRef.current.find((candidate) => candidate.id === id);
          if (!node) return;
          setComposer({ mode: "edit", id });
          setComposerValue(bubbleLabel(node));
        }}
        onAdd={(parentId) => { setComposer({ mode: "add", parentId }); setComposerValue(""); }}
        onAskAI={askAboutBubble}
        onArmConnect={(id) => setConnectFromId((current) => (current === id ? null : id))}
        onConnectTarget={connectTarget}
        onSpawnFreeform={spawnFreeform}
        onDelete={deleteBubble}
        onAcceptGhost={() => {}}
        onDismissGhost={() => {}}
        onRemoveConnection={removeConnection}
        connectFromId={connectFromId}
        zoom={zoom}
        setZoom={setZoom}
        pan={pan}
        setPan={setPan}
        showSuggestions={showSuggestions}
        showProvenance={false}
        focusId={focusId}
        reducedMotion={reducedMotion}
        marqueeActive={false}
      />

      {!nodes.length && (
        <div className="session-empty" aria-hidden="true">
          <IconSparkles />
          <p>Say what you're thinking.</p>
          <small>Complete thoughts become bubbles; the full transcript stays underneath.</small>
        </div>
      )}

      <nav className="side-rail session-side-rail" aria-label="Workspace and session tools">
        <IconButton
          label="Conversation"
          active={drawerOpen && drawerTab === "conversation"}
          onClick={() => openDrawer("conversation")}
          testId="conversation-tool"
        >
          <IconMessageCircle />
        </IconButton>
        <IconButton
          label="Search"
          active={drawerOpen && drawerTab === "search"}
          onClick={() => openDrawer("search")}
          testId="search-tool"
        >
          <IconSearch />
        </IconButton>
        <IconButton
          label={focusId ? "Show full map" : "Focus selected branch"}
          active={Boolean(focusId)}
          onClick={toggleFocus}
          testId="focus-tool"
        >
          <IconFocusCentered />
        </IconButton>
        <IconButton
          label="Activity"
          active={drawerOpen && drawerTab === "activity"}
          onClick={() => openDrawer("activity")}
          testId="activity-tool"
        >
          <IconClock />
        </IconButton>
        <IconButton
          label={favorite ? "Remove favorite" : "Add favorite"}
          pressed={favorite}
          onClick={() => {
            setFavorite((value) => !value);
            showToast(favorite ? "Removed from favorites" : "Added to favorites");
          }}
          testId="favorite-tool"
        >
          <IconStar />
        </IconButton>
        <IconButton
          label="Account"
          active={drawerOpen && drawerTab === "profile"}
          onClick={() => openDrawer("profile")}
          className="avatar-button rail-bottom"
          testId="profile-tool"
        >
          MR
        </IconButton>
        <IconButton
          label="Settings"
          active={drawerOpen && drawerTab === "settings"}
          onClick={() => openDrawer("settings")}
          testId="settings-tool"
        >
          <IconSettings />
        </IconButton>
      </nav>

      {drawerOpen && (
        <aside className="session-drawer" aria-label="Conversation and activity">
          <header className="panel-header session-panel-header">
            <div className="panel-title-mark"><DrawerIcon /></div>
            <div><span>{drawerPresentation.eyebrow}</span><h2>{drawerPresentation.title}</h2></div>
            <IconButton label="Close panel" onClick={() => setDrawerOpen(false)} className="panel-close"><IconX /></IconButton>
          </header>

          {(drawerTab === "conversation" || drawerTab === "activity") && (
            <div className="session-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={drawerTab === "conversation"}
                className={drawerTab === "conversation" ? "is-active" : ""}
                onClick={() => setDrawerTab("conversation")}
              >
                Conversation
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={drawerTab === "activity"}
                className={drawerTab === "activity" ? "is-active" : ""}
                onClick={() => setDrawerTab("activity")}
              >
                Activity
              </button>
            </div>
          )}

          {drawerTab === "conversation" ? (
            <>
              <div className="session-transcript" data-testid="transcript">
                {!transcript.length && (
                  <p className="empty-state">The transcript is the record; the map is the interpretation. Start anywhere.</p>
                )}
                {transcript.map((utterance) => (
                  <div
                    key={utterance.id}
                    ref={(element) => {
                      if (element) utteranceElementsRef.current.set(utterance.id, element);
                      else utteranceElementsRef.current.delete(utterance.id);
                    }}
                    className={`session-utterance ${utterance.speaker} ${highlight?.utteranceId === utterance.id ? "is-highlighted" : ""}`}
                  >
                    <span>{utterance.speaker === "you" ? "You" : "Partner"} · {utterance.at}</span>
                    <p>{renderUtteranceText(utterance)}</p>
                  </div>
                ))}
                <div ref={transcriptEndRef} />
              </div>
              <form className="session-chat" onSubmit={submitChat}>
                <input
                  ref={chatInputRef}
                  value={chatValue}
                  onChange={(event) => setChatValue(event.target.value)}
                  placeholder={listening ? "Listening…" : "Type a thought or ask the partner…"}
                  disabled={listening}
                />
                <IconButton type="submit" label="Send" disabled={!chatValue.trim() || listening}><IconSend /></IconButton>
              </form>
            </>
          ) : drawerTab === "activity" ? (
            <>
              <div className="history-actions">
                <IconButton label="Undo" onClick={undo} disabled={historyIndex <= 0}><IconArrowBackUp /></IconButton>
                <IconButton label="Redo" onClick={redo} disabled={historyIndex >= historyEntries.length - 1}><IconArrowForwardUp /></IconButton>
              </div>
              <div className="session-ledger">
                {!ledger.length && <p className="empty-state">Every map change lands here with who made it.</p>}
                {[...ledger].reverse().map((entry) => (
                  <div key={entry.id} className={`session-ledger-entry actor-${entry.actor}`}>
                    <span>{entry.actor === "you" ? "You" : "Partner"}</span>
                    <p>{entry.label}</p>
                    <small>{entry.at}</small>
                  </div>
                ))}
              </div>
            </>
          ) : drawerTab === "search" ? (
            <div className="session-search-panel">
              <label className="search-field">
                <IconSearch />
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search thoughts…"
                />
              </label>
              <div className="panel-list search-results">
                {searchResults.map((node) => (
                  <button type="button" key={node.id} onClick={() => { selectOne(node.id); setDrawerOpen(false); }}>
                    <span>{bubbleLabel(node)}</span>
                  </button>
                ))}
                {!searchResults.length && <p className="empty-state">No matching thoughts yet.</p>}
              </div>
            </div>
          ) : drawerTab === "profile" ? (
            <div className="session-profile-panel">
              <div className="profile-card"><span>MR</span><div><strong>Solo workspace</strong><small>Private by default</small></div></div>
              <div className="panel-note"><IconUser /><span>The complete transcript and accepted map stay together in this local session.</span></div>
            </div>
          ) : (
            <div className="session-settings-panel">
              <label className="session-setting-row">
                <span><strong>Reduced motion</strong><small>Freeze deformation cues and reveal connections immediately</small></span>
                <input type="checkbox" checked={reducedMotion} onChange={(event) => setReducedMotion(event.target.checked)} />
              </label>
              <label className="session-setting-row">
                <span><strong>Partner proposals</strong><small>Show ghost suggestions and their evidence cards</small></span>
                <input type="checkbox" checked={showSuggestions} onChange={(event) => setShowSuggestions(event.target.checked)} />
              </label>
            </div>
          )}
        </aside>
      )}

      {selected && sourceUtterance && (
        <div className="session-provenance" data-testid="provenance-chip">
          <IconQuote />
          <p>“…{sourceUtterance.text.slice(selectedSource.span[0], selectedSource.span[1])}…”</p>
          <button type="button" onClick={() => openEvidence(sourceUtterance.id, selected.id)}>Show in transcript</button>
        </div>
      )}

      {showSuggestions && <div className="session-proposals">
        {proposals.map((proposal) => (
          <article
            key={proposal.id}
            className="session-proposal"
            data-testid="curator-proposal"
          >
            <header><i className="session-proposal-mark"><IconSparkles /></i><span>Partner suggests</span></header>
            <p>{proposal.rationale}.</p>
            <small className="session-proposal-stale">
              Source map revision {proposal.baseRev}
              {proposal.baseRev !== revRef.current ? " — re-checked on accept" : ""}
            </small>
            <footer>
              <IconButton
                label="Accept AI suggestion"
                className="session-accept"
                onClick={() => acceptProposal(proposal)}
                testId="accept-suggestion"
              >
                <IconCheck />
              </IconButton>
              <IconButton
                label="Dismiss AI suggestion"
                className="session-dismiss"
                onClick={() => dismissProposal(proposal)}
                testId="dismiss-suggestion"
              >
                <IconX />
              </IconButton>
              {proposal.evidence.slice(0, 2).map((utteranceId) => (
                <button key={utteranceId} type="button" className="session-evidence" onClick={() => openEvidence(utteranceId)}>
                  <IconQuote />source
                </button>
              ))}
            </footer>
          </article>
        ))}
      </div>}

      {composer && (
        <form className="session-composer" onSubmit={submitComposer}>
          <label>
            <span>{composer.mode === "edit" ? "Rewrite this bubble" : "Add a thought"}</span>
            <textarea
              autoFocus
              rows="3"
              value={composerValue}
              onChange={(event) => setComposerValue(event.target.value)}
              placeholder="Keep it short — the transcript keeps the rest"
            />
          </label>
          <div>
            <IconButton label="Cancel" onClick={() => setComposer(null)}><IconX /></IconButton>
            <IconButton type="submit" label={composer.mode === "edit" ? "Save label" : "Add bubble"} disabled={!composerValue.trim()}><IconCheck /></IconButton>
          </div>
        </form>
      )}

      {listening && (
        <div className="voice-caption session-caption" role="status" aria-live="polite">
          <span />
          <p>Listening for a complete thought…</p>
          <small>{liveCaption || "…"}</small>
        </div>
      )}

      <div className={`voice-control ${listening ? "is-listening" : ""}`}>
        <span className="voice-timer">{timer}</span>
        <IconButton
          label={listening ? "Finish thought" : "Start voice capture"}
          pressed={listening}
          onClick={toggleVoice}
          testId="voice-control"
        >
          {listening ? <IconCheck /> : <IconMicrophone />}
        </IconButton>
      </div>

      <div className="zoom-controls" aria-label="Canvas zoom">
        <IconButton label="Center map" onClick={() => { setPan({ x: 0, y: 0 }); setZoom(1); }}><IconFocusCentered /></IconButton>
        <IconButton label="Zoom out" onClick={() => setZoom((value) => clamp(value - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))}><IconMinus /></IconButton>
        <span>{Math.round(zoom * 100)}%</span>
        <IconButton label="Zoom in" onClick={() => setZoom((value) => clamp(value + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))}><IconPlus /></IconButton>
      </div>

      {connectFromId && (
        <div className="connect-hint" role="status"><span>Select another bubble to connect</span><IconButton label="Cancel connection" onClick={() => setConnectFromId(null)}><IconX /></IconButton></div>
      )}

      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </main>
  );
}
