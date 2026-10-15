import { createEmptySession, validateSession } from "../shared/sessionSchema.mjs";
import { applyOperation } from "../shared/sessionOperations.mjs";

// Authored, public-safe example content. This is not a recording of a real user.
export function createExampleSession({ id = `example_${crypto.randomUUID()}` } = {}) {
  let session = createEmptySession({ id, title: "A neighborhood reading room" });
  let sequence = 0;
  const apply = operation => {
    const result = applyOperation(session, { actor: "you", origin: "ui", ...operation, expected_revision: session.revision }, {
      idFactory: kind => `${kind}_example_${++sequence}`,
    });
    session = result.session;
    return result;
  };
  const say = (text, speaker = "you") => {
    apply({ type: "append_utterance", text, speaker, actor: speaker });
    return session.transcript.at(-1);
  };
  const span = (utterance, quote) => ({ utterance_id: utterance.id, start: utterance.text.indexOf(quote), end: utterance.text.indexOf(quote) + quote.length, quote });
  const idea = (node_id, text, utterance, quote, x, y, parent) => apply({ type: "create_bubble", node_id, text, source: span(utterance, quote), x, y, parent, actor: "partner", origin: "map_controller" });

  const purpose = say("I want a neighborhood reading room. Somewhere to read alongside other people without having to buy anything.");
  idea("reading_room", "A neighborhood reading room", purpose, "neighborhood reading room", 490, 485);
  idea("free_access", "Free access", purpose, "without having to buy anything", 745, 630, "reading_room");
  say("What would make it feel different from a café?", "partner");
  const atmosphere = say("Quiet mornings for reading, and shared evenings for conversation. The same space could serve both, just at different times.");
  idea("quiet_mornings", "Quiet mornings", atmosphere, "Quiet mornings for reading", 745, 330, "reading_room");
  idea("shared_evenings", "Shared evenings", atmosphere, "shared evenings for conversation", 980, 465, "quiet_mornings");
  const upkeep = say("Free access matters to me, but someone still has to look after the room. We could share the upkeep among regular visitors.");
  idea("shared_upkeep", "Shared upkeep", upkeep, "share the upkeep among regular visitors", 1000, 705, "free_access");
  const uncertainty = say("I don't know whether people would return regularly. I'd like to learn that before we commit to a permanent space.");
  apply({
    type: "propose_changes", actor: "curator", proposal_id: "trial_proposal",
    rationale: "A one-week trial could reveal whether quiet reading and shared evenings bring people back before you commit to a permanent space.",
    evidence: [span(uncertainty, "learn that before we commit to a permanent space")],
    operations: [{ type: "create_bubble", node_id: "one_week_trial", text: "A one-week trial", parent: "reading_room" }],
  });
  session.map_controller.processed_transcript_count = session.transcript.length;
  session.preferences.partner_mode = "quiet";
  session.synthesis = {
    text: "A shared reading room could offer quiet company without an expectation to spend money. Quiet mornings and conversational evenings would use the same space in different ways. Shared upkeep may support free access, but whether people will return regularly is still an open question.",
    revision: session.revision, created_at: session.updated_at,
  };
  return validateSession(session);
}
