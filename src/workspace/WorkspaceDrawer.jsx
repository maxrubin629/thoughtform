import { formatClock, formatUpdated, nodeLabel } from "./format.js";
import React from "react";
import {
  IconArrowBackUp, IconArrowForwardUp, IconCheck, IconClock, IconDownload,
  IconEye, IconGridDots, IconHierarchy2, IconMap2, IconMessageCircle, IconPencil,
  IconPlus, IconQuote, IconSearch, IconSend, IconSettings, IconSparkles, IconStack2,
  IconTrash, IconUser, IconX,
} from "@tabler/icons-react";
import { IconButton } from "../canvas/IconButton.jsx";
import { clamp } from "../fluidMaterial.js";
import { actorLabel, activityLabel, proposalOperationLabel } from "../session/presentation.js";
import { groupUtterancesByPause } from "../workspaceUi.js";

export function UtteranceText({ utterance, highlight, nodes }) {
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
}

function MapsPanel({ session: canonical, library }) {
  const { sessions, renameId, renameValue, setRenameId, setRenameValue, saveRename, createNewMap, openSession, removeMap } = library;
  return (
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
      <div className="panel-note"><IconEye /><span>Your maps stay on this device, ready to pick up where you left off.</span></div>
    </div>
  );
}

function ConversationPanel({ session: canonical, map, conversation }) {
  const { selected, nodes } = map;
  const { conversationTimeline, highlight, utteranceElementsRef, transcriptEndRef, chatInputRef, chatValue, setChatValue, busy, submitChat } = conversation;
  return (
    <>
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
                        <UtteranceText utterance={utterance} highlight={highlight} nodes={nodes} />
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
      <form className="session-chat" onSubmit={submitChat}>
        <input ref={chatInputRef} value={chatValue} onChange={(event) => setChatValue(event.target.value)} aria-label="Message Partner" placeholder={selected ? "Talk about the selected thought…" : "Think aloud with Partner…"} />
        <IconButton type="submit" label="Send" disabled={!chatValue.trim() || busy}><IconSend /></IconButton>
      </form>
    </>
  );
}

function ActivityPanel({ session: canonical, history }) {
  const { undo, redo, undoLabel, canRedo } = history;
  return (
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
  );
}

function SearchPanel({ map }) {
  const { searchQuery, setSearchQuery, searchResults, focusSearchResult } = map;
  return (
    <div className="session-search-panel">
      <label className="search-field"><IconSearch /><input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search thoughts…" /></label>
      <div className="panel-list search-results">
        {searchResults.map((node) => <button type="button" key={node.id} onClick={() => focusSearchResult(node.id)}><span>{nodeLabel(node)}</span></button>)}
        {!searchResults.length && <p className="empty-state">No matching thoughts yet.</p>}
      </div>
    </div>
  );
}

function SourcesPanel({ session: canonical, map, conversation }) {
  const { selected } = map;
  const { openEvidence } = conversation;
  if (!selected) return <div className="session-panel-copy session-sources"><p>Select a thought to see the exact words it came from.</p></div>;
  const emptyMessage = selected.ghost
    ? "This suggestion goes beyond the conversation. Review its reasoning in Suggestions."
    : "This thought was added directly to the map.";
  return (
    <div className="session-panel-copy session-sources">
      <h3>{nodeLabel(selected)}</h3>
      {!selected.sources?.length && <p>{emptyMessage}</p>}
      {selected.sources?.map((source, index) => {
        const utterance = canonical.transcript.find((item) => item.id === source.utteranceId);
        if (!utterance) return null;
        return <blockquote key={`${source.utteranceId}-${index}`}>
          <p>{utterance.text.slice(source.span[0], source.span[1])}</p>
          <footer>{utterance.speaker === "you" ? "You" : "Partner"} · {formatClock(utterance.completed_at)}
            <button type="button" onClick={() => openEvidence(utterance.id, selected.id)}>Show in conversation</button>
          </footer>
        </blockquote>;
      })}
    </div>
  );
}

function SettingSwitch({ label, description, checked, onChange, disabled }) {
  return <label className="session-setting-row">
    <span><strong>{label}</strong><small>{description}</small></span>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
  </label>;
}

function ChoiceButtons({ label, options, value, onChange, disabled }) {
  return <div className="segmented-control" aria-label={label}>
    {options.map(([option, text]) => <button key={option} type="button" disabled={disabled}
      className={value === option ? "is-active" : ""} onClick={() => onChange(option)}>{text}</button>)}
  </div>;
}

function ProposalsPanel({ proposals, preferences, conversation }) {
  const { pendingProposals, excludeProposalOperation, acceptProposal, dismissProposal, exploreProposal } = proposals;
  const { showSuggestions, setShowSuggestions } = preferences;
  const { openEvidence } = conversation;
  return (
    <div className="session-panel-copy session-suggestions-list">
      <SettingSwitch label="Show on canvas" description="Suggestions stay separate until accepted" checked={showSuggestions} onChange={setShowSuggestions} />
      {!pendingProposals.length && <p className="empty-state">No suggestions waiting. A useful new angle will appear here when Partner finds one.</p>}
      {pendingProposals.map((proposal) => (
        <article key={proposal.id} className={`session-proposal ${proposal.status === "stale" ? "is-stale" : ""}`} data-testid="partner-proposal">
          <header><i className="session-proposal-mark"><IconSparkles /></i><span>Partner suggests</span></header>
          <p>{proposal.rationale}</p>
          {proposal.status === "stale" && <small>This suggestion no longer fits the current map.</small>}
          <div className="session-proposal-operations">{(proposal.operations ?? []).map((operation) => <div key={operation.id} className={operation.excluded ? "is-excluded" : ""}><span>{proposalOperationLabel(operation)}</span>{proposal.status === "pending" && !operation.excluded && <IconButton label="Exclude this change" onClick={() => excludeProposalOperation(proposal, operation)}><IconX /></IconButton>}</div>)}</div>
          <details className="session-proposal-evidence"><summary>Why this idea?</summary><p>{proposal.rationale}</p>{(proposal.evidence ?? []).map((evidence, index) => {
            const utteranceId = evidence.utterance_id ?? (typeof evidence === "string" ? evidence : null);
            const spans = Number.isInteger(evidence?.start) && Number.isInteger(evidence?.end) ? [[evidence.start, evidence.end]] : null;
            return utteranceId ? <button key={`${utteranceId}-${index}`} type="button" className="session-evidence" onClick={() => openEvidence(utteranceId, null, spans)}><IconQuote />{evidence.quote ? `“${evidence.quote}”` : "Conversation source"}</button> : null;
          })}</details>
          <footer>
            <button type="button" className="session-proposal-explore" onClick={() => exploreProposal(proposal)}><IconMessageCircle />Explore</button>
            <IconButton label="Accept AI suggestion" className="session-accept" disabled={proposal.status === "stale" || !(proposal.operations ?? []).some((operation) => !operation.excluded)} onClick={() => acceptProposal(proposal)} testId="accept-suggestion"><IconCheck /></IconButton>
            <IconButton label="Dismiss AI suggestion" className="session-dismiss" onClick={() => dismissProposal(proposal)} testId="dismiss-suggestion"><IconX /></IconButton>
          </footer>
        </article>
      ))}
    </div>
  );
}

function LayoutsPanel({ map }) {
  const { viewMode, changeView } = map;
  return (
    <div className="session-panel-copy">
      <ChoiceButtons label="Graph layout" options={[["clusters", "Clusters"], ["hierarchy", "Hierarchy"]]} value={viewMode} onChange={changeView} />
      <p className="panel-description">Two views of the same canonical graph. Cluster mode keeps the fluid physics active.</p>
    </div>
  );
}

function SynthesisPanel({ session: canonical, proposals, synthesis: synthesisState }) {
  const { pendingProposals } = proposals;
  const { synthesis, synthesizing, requestSynthesis, exportSession } = synthesisState;
  return (
    <div className="session-panel-copy">
      <div className="map-stats"><span><strong>{canonical?.nodes?.length ?? 0}</strong><small>Thoughts</small></span><span><strong>{canonical?.edges?.length ?? 0}</strong><small>Links</small></span><span><strong>{pendingProposals.length}</strong><small>Proposals</small></span></div>
      <button type="button" className="wide-action" disabled={synthesizing || !canonical?.nodes?.length} onClick={requestSynthesis}><IconSparkles />{synthesizing ? "Synthesizing…" : "Write a synthesis"}</button>
      {synthesis && <><div className="session-synthesis"><p>{synthesis}</p></div><p className="session-synthesis-meta">Saved {formatUpdated(canonical?.synthesis?.created_at)}{canonical?.synthesis?.revision !== canonical?.revision ? " · The conversation may have moved on since this was written." : ""}</p></>}
      <div className="session-export-actions"><button type="button" onClick={() => exportSession("markdown")}><IconDownload />Export notes</button><button type="button" onClick={() => exportSession("json")}>Full session</button></div>
    </div>
  );
}

function LayersPanel({ preferences }) {
  const { showSuggestions, setShowSuggestions, showProvenance, setShowProvenance } = preferences;
  return (
    <div className="session-settings-panel">
      <SettingSwitch label="Partner proposals" description="Show ghost branches and tethers" checked={showSuggestions} onChange={setShowSuggestions} />
      <SettingSwitch label="Provenance labels" description="Reveal transcript-source labels on bubbles" checked={showProvenance} onChange={setShowProvenance} />
    </div>
  );
}

function ProfilePanel() {
  return (
    <div className="session-profile-panel"><div className="profile-card"><span>MR</span><div><strong>Solo workspace</strong><small>Private by default</small></div></div><div className="panel-note"><IconUser /><span>The transcript and accepted map stay together in this local session.</span></div></div>
  );
}

function SettingsPanel({ preferences }) {
  const { partnerMode, mappingPaused, preferenceBusy, setPreferences, reducedMotion, setReducedMotion, showSuggestions, setShowSuggestions } = preferences;
  return (
    <div className="session-settings-panel">
      <div className="session-voice-mode">
        <span><strong>Partner’s initiative</strong><small>Quiet keeps conversation and mapping active. Proactive also offers new angles.</small></span>
        <ChoiceButtons options={[["quiet", "Quiet"], ["proactive", "Proactive"]]} value={partnerMode}
          disabled={preferenceBusy} onChange={(partner_mode) => setPreferences({ partner_mode })} />
      </div>
      <SettingSwitch label="Pause mapping" description="Keep talking; your full conversation is still saved"
        checked={mappingPaused} disabled={preferenceBusy} onChange={(mapping_paused) => setPreferences({ mapping_paused })} />
      <SettingSwitch label="Reduced motion" description="Freeze deformation cues and reveal connections immediately" checked={reducedMotion} onChange={setReducedMotion} />
      <SettingSwitch label="Partner proposals" description="Show reviewable ghost suggestions" checked={showSuggestions} onChange={setShowSuggestions} />
    </div>
  );
}


const DRAWER_PANELS = {
  maps: { component: MapsPanel, eyebrow: "Workspace", title: "Your maps", icon: IconMap2 },
  sources: { component: SourcesPanel, eyebrow: "Exact words", title: "Thought sources", icon: IconQuote },
  conversation: { component: ConversationPanel, eyebrow: "Session", title: "Conversation", icon: IconMessageCircle },
  activity: { component: ActivityPanel, eyebrow: "Timeline", title: "Map activity", icon: IconClock },
  search: { component: SearchPanel, eyebrow: "Find", title: "Search this map", icon: IconSearch },
  proposals: { component: ProposalsPanel, eyebrow: "Partner", title: "Review proposals", icon: IconSparkles },
  layouts: { component: LayoutsPanel, eyebrow: "One graph", title: "Switch the view", icon: IconHierarchy2 },
  overview: { component: SynthesisPanel, eyebrow: "Your thinking, together", title: "Synthesis", icon: IconGridDots },
  layers: { component: LayersPanel, eyebrow: "Visibility", title: "Canvas layers", icon: IconStack2 },
  profile: { component: ProfilePanel, eyebrow: "Local profile", title: "MR", icon: IconUser },
  settings: { component: SettingsPanel, eyebrow: "Preferences", title: "Session settings", icon: IconSettings },
};

const PRIMARY_TABS = [
  ["conversation", "Conversation", IconMessageCircle],
  ["sources", "Sources", IconQuote],
  ["proposals", "Suggestions", IconSparkles],
  ["overview", "Synthesis", IconGridDots],
];

function DrawerResizeHandle({ width, setWidth }) {
  const release = (event) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  return <div className="session-resize-handle" role="separator" aria-label="Resize detail panel"
    aria-orientation="vertical" aria-valuemin={300} aria-valuemax={560}
    aria-valuenow={width} aria-valuetext={`${Math.round(width)} pixels wide`} tabIndex={0}
    onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      setWidth((value) => clamp(value + (event.key === "ArrowRight" ? 20 : -20), 300, 560));
    }}
    onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
    onPointerMove={(event) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const left = event.currentTarget.parentElement.getBoundingClientRect().left;
      setWidth(clamp(event.clientX - left, 300, Math.min(560, window.innerWidth - left - 20)));
    }} onPointerUp={release} onPointerCancel={release} />;
}

/**
 * One detail drawer routes to independently readable panels.
 * Each panel consumes its named domain object; canonical session data is read-only.
 * drawer owns open/tab/width state; actions stay with the owning workspace hook.
 * Panel declarations document which fields each domain must provide.
 */
export function WorkspaceDrawer({ drawer, ...domains }) {
  const { drawerOpen, drawerTab, drawerWidth, setDrawerOpen, setDrawerTab, setDrawerWidth } = drawer;
  if (!drawerOpen) return null;
  const { title, eyebrow, icon: DrawerIcon, component: Panel } = DRAWER_PANELS[drawerTab] ?? DRAWER_PANELS.conversation;
  const proposalCount = domains.proposals.pendingProposals.length;
  return (
    <aside className="session-drawer" aria-label={title} data-testid={`${drawerTab}-panel`}>
      <header className="panel-header session-panel-header">
        <div className="panel-title-mark"><DrawerIcon /></div>
        <div><span>{eyebrow}</span><h2>{title}</h2></div>
        <IconButton label="Close panel" onClick={() => setDrawerOpen(false)} className="panel-close"><IconX /></IconButton>
      </header>
      {PRIMARY_TABS.some(([tab]) => tab === drawerTab) && (
        <div className="session-tabs session-primary-tabs" role="tablist" aria-label="Session details">
          {PRIMARY_TABS.map(([tab, label, TabIcon]) => (
            <button key={tab} type="button" role="tab" aria-selected={drawerTab === tab}
              className={drawerTab === tab ? "is-active" : ""} onClick={() => setDrawerTab(tab)} title={label}>
              <TabIcon /><span>{label}</span>{tab === "proposals" && proposalCount > 0 && <i>{proposalCount}</i>}
            </button>
          ))}
        </div>
      )}
      <DrawerResizeHandle width={drawerWidth} setWidth={setDrawerWidth} />
      <Panel {...domains} />
    </aside>
  );
}
