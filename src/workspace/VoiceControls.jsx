import {
  IconMicrophone, IconMicrophoneOff, IconPlayerPause, IconPlayerPlay,
  IconPlayerStop, IconSparkles, IconX,
} from "@tabler/icons-react";
import { IconButton } from "../canvas/IconButton.jsx";

/** Voice owns audio state; preferences and controller state stay separate. */
export function VoiceControls({ voice, preferences, controller }) {
  const { liveCaption, partnerCaption, backendState, voiceConnected, voiceStarting, timer,
    muted, mutePending, toggleMute, endVoice, stopRealtime, startVoice, voiceError, setVoiceError } = voice;
  const { partnerMode, mappingPaused, preferenceBusy, setPreferences } = preferences;
  const { controllerStatus, controllerRetrying, retryMapController } = controller;
  return <>
  {(liveCaption || partnerCaption) && <div className="session-live-captions" aria-label="Live captions">
    {liveCaption && <div><span>You</span><p>{liveCaption}</p></div>}
    {partnerCaption && <div><span>Partner</span><p>{partnerCaption}</p></div>}
  </div>}

  <div className="session-conversation-controls">
    <div className="session-presence-controls" aria-label="Partner and mapping preferences">
      <button type="button" title={partnerMode === "quiet" ? "Quiet: conversation and capture, without unsolicited suggestions" : "Proactive: Partner may suggest useful new angles"} disabled={preferenceBusy} onClick={() => setPreferences({ partner_mode: partnerMode === "quiet" ? "proactive" : "quiet" })}><IconSparkles /><span>{partnerMode === "quiet" ? "Quiet" : "Proactive"}</span></button>
      <button type="button" className={mappingPaused ? "is-paused" : ""} title={mappingPaused ? "Resume mapping completed thoughts" : "Pause mapping; keep the conversation going"} aria-pressed={mappingPaused} disabled={preferenceBusy} onClick={() => setPreferences({ mapping_paused: !mappingPaused })}>{mappingPaused ? <IconPlayerPlay /> : <IconPlayerPause />}<span>{mappingPaused ? "Mapping paused" : "Mapping on"}</span></button>
    </div>
    <div className="session-backend-status" role="status" aria-live="polite">
      {controllerStatus?.kind === "error" ? <><span>{controllerStatus.label}</span><button type="button" onClick={retryMapController} disabled={controllerRetrying}>{controllerRetrying ? "Retrying…" : "Retry"}</button></> : <span>{backendState === "working" ? "Partner is thinking…" : controllerStatus?.kind === "active" ? controllerStatus.label : mappingPaused ? "Your conversation is still being saved" : ""}</span>}
    </div>
    <div className={`voice-control ${voiceConnected && !muted ? "is-listening" : ""}`}>
      <span className="voice-timer">{voiceConnected ? timer : voiceStarting ? "Connecting…" : "Talk with Partner"}</span>
      {voiceConnected ? <><IconButton label={muted ? "Unmute microphone" : "Mute microphone"} pressed={muted} disabled={mutePending} onClick={toggleMute} testId="voice-control">{muted ? <IconMicrophoneOff /> : <IconMicrophone />}</IconButton><IconButton label="End voice conversation" className="session-end-voice" onClick={endVoice}><IconPlayerStop /></IconButton></> : <IconButton label={voiceStarting ? "Cancel voice connection" : "Start voice conversation"} onClick={voiceStarting ? stopRealtime : startVoice} testId="voice-control">{voiceStarting ? <IconX /> : <IconMicrophone />}</IconButton>}
      {voiceConnected && <small className="session-mute-label">{muted ? "Mic muted" : "Listening"}</small>}
    </div>
  </div>
  {voiceError && <div className="session-voice-error" role="status">{voiceError} <button type="button" onClick={() => setVoiceError("")}>Dismiss</button></div>}
  </>;
}
