// The simulated conversational layer (the gpt-realtime role): keeps the
// exchange moving with a short reflection plus at most one question. It never
// restructures the map and never speaks unprompted — silence means thinking.
// Replace `partnerReply` with a realtime-model call; the contract (utterance
// context in, one short spoken line out) stays the same.

const OPENERS = [
  "Got it — that's on the map.",
  "Captured.",
  "Okay, I've sketched that.",
  "That's down.",
];

const QUESTIONS = [
  (label) => `What's driving “${label}” for you?`,
  (label) => `What would “${label}” look like in practice?`,
  (label) => `Does “${label}” sit in tension with anything already up there?`,
  (label) => `What's the smallest version of “${label}”?`,
  (label) => `Who feels “${label}” the most?`,
];

const REVISIT_LINES = [
  (label) => `You keep circling “${label}” — I've made it weightier. What's changed since you first said it?`,
  (label) => `That connects back to “${label}”. Say more about the link?`,
];

const IDLE_LINES = [
  "I'm with you — keep going.",
  "Noted. What feels most alive right now?",
];

export function partnerReply({ ideas = [], revisited = [], turn = 0 }) {
  if (revisited.length) {
    return REVISIT_LINES[turn % REVISIT_LINES.length](revisited[0]);
  }
  if (ideas.length) {
    const opener = OPENERS[turn % OPENERS.length];
    const question = QUESTIONS[turn % QUESTIONS.length](ideas[ideas.length - 1].label);
    return ideas.length > 1
      ? `${opener} I heard ${ideas.length} distinct ideas in that. ${question}`
      : `${opener} ${question}`;
  }
  return IDLE_LINES[turn % IDLE_LINES.length];
}

// Canned stream-of-thought monologues for the simulated dictation path, so
// the full voice pipeline (streaming partials → boundary commit → condense)
// is demonstrable without live ASR. Deliberately rambly: condensation should
// visibly compress them.
export const DICTATIONS = [
  "So I keep coming back to the idea that the map should form while I'm still talking, because seeing the structure appear is what tells me where to go next.",
  "Maybe the bubbles should stay really short, like a compressed version of what I said, and the full transcript stays underneath as the actual record.",
  "I think the AI should ask me one good question at a time, but it has to be comfortable with silence when I'm just thinking.",
  "The important part is that accepting a suggestion should feel like the map growing on its own, and rejecting one should cost me nothing.",
];

