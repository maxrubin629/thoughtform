import { useCallback, useEffect, useRef, useState } from "react";
import { createSessionLiveClient } from "../sessionLive.js";
import { sendSessionChat } from "../liveApi.js";
import { updateSessionUiContext } from "../sessionApi.js";
import { snapshotFrom } from "./useCanonicalSession.js";

import { nodeLabel } from "./format.js";

export function useSessionVoice({ session, graph, selection }) {
  const { canonical, canonicalRef, sessionIdRef, applyCanonicalSnapshot } = session;
  const { nodesRef, proposalNodesRef } = graph;
  const { selectedId, selectedIds, focusId, viewMode } = selection;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const realtimeRef = useRef(null);
  const audioRef = useRef(null);
  const [voiceState, setVoiceState] = useState("idle");
  const [voiceError, setVoiceError] = useState("");
  const [liveCaption, setLiveCaption] = useState("");
  const [partnerCaption, setPartnerCaption] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [mutePending, setMutePending] = useState(false);
  const [backendState, setBackendState] = useState("idle");

  const getSelectedContext = useCallback(() => {
    const selected = selectionRef.current;
    const ghost = proposalNodesRef.current.find((node) => node.id === selected.selectedId);
    const ids = new Set(canonicalRef.current?.nodes.map((node) => node.id));
    const committedSelection = selected.selectedIds.filter((id) => ids.has(id));
    return {
      selectedNodeIds: committedSelection,
      selectedProposalId: ghost?.proposalId ?? null,
      selectedText: ghost ? nodeLabel(ghost) : nodesRef.current.filter((node) => committedSelection.includes(node.id)).map(nodeLabel).join("; "),
    };
  }, [canonicalRef, nodesRef, proposalNodesRef]);

  const updateContext = useCallback(async () => {
    const context = getSelectedContext();
    const selected = selectionRef.current;
    await updateSessionUiContext(sessionIdRef.current, {
      selected_node_ids: context.selectedNodeIds,
      selected_proposal_id: context.selectedProposalId,
      focus_id: selected.focusId,
      view_mode: selected.viewMode,
    });
    return context;
  }, [getSelectedContext, sessionIdRef]);

  useEffect(() => {
    if (!canonical?.id) return undefined;
    const timer = window.setTimeout(() => {
      updateContext().catch(() => {});
      realtimeRef.current?.updateContext(getSelectedContext())?.catch?.(() => {});
    }, 150);
    return () => window.clearTimeout(timer);
  }, [canonical?.id, focusId, selectedId, selectedIds, viewMode, updateContext, getSelectedContext]);

  const stopRealtime = useCallback(() => {
    realtimeRef.current?.disconnect();
    realtimeRef.current = null;
    setVoiceState("idle");
    setLiveCaption("");
    setPartnerCaption("");
    setSeconds(0);
    setMuted(false);
    setMutePending(false);
    setBackendState("idle");
  }, []);

  useEffect(() => () => stopRealtime(), [stopRealtime]);
  useEffect(() => {
    if (!realtimeRef.current?.connected) return undefined;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [voiceState]);

  const startVoice = async () => {
    if (!canonical?.id || realtimeRef.current?.connected) return;
    setVoiceError("");
    setSeconds(0);
    const realtime = createSessionLiveClient({
      sessionId: sessionIdRef.current,
      audioElement: audioRef.current,
      getSelectedContext,
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
  const sendConversation = async (text) => {
    const targetSessionId = sessionIdRef.current;
    const client = realtimeRef.current;
    if (!targetSessionId) throw new Error("Open a map before starting a conversation");
    await updateContext();
    const result = client?.connected
      ? await client.sendText(text)
      : await sendSessionChat(targetSessionId, text);
    const snapshot = snapshotFrom(result);
    if (snapshot) applyCanonicalSnapshot(snapshot);
    return result;
  };

  return {
    audioRef, voiceError, setVoiceError, liveCaption, partnerCaption, muted, mutePending, backendState,
    voiceConnected: Boolean(realtimeRef.current?.connected),
    voiceStarting: ["connecting", "requesting_microphone", "reconnecting", "ending"].includes(voiceState),
    timer: `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`,
    stopRealtime, startVoice, endVoice, toggleMute, sendConversation,
  };
}
