// Extractive condensation: turns a committed utterance into concise bubble
// labels plus the exact character span each label came from. The label IS a
// contiguous quote of the user's words, so provenance highlighting is exact
// and the map keeps the user's own vocabulary. A model-backed condenser can
// replace `condenseUtterance` with abstractive labels later — the contract
// (label + source spans per idea) stays the same.

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "so", "if", "then", "than", "that",
  "this", "these", "those", "there", "here", "it", "its", "it's", "i", "im",
  "i'm", "ive", "i've", "id", "i'd", "me", "my", "we", "our", "you", "your",
  "he", "she", "they", "them", "their", "is", "are", "was", "were", "be",
  "been", "being", "am", "do", "does", "did", "have", "has", "had", "will",
  "would", "should", "could", "can", "cant", "can't", "just", "really",
  "very", "kind", "sort", "of", "in", "on", "at", "to", "for", "from",
  "with", "about", "into", "over", "after", "before", "as", "by", "not",
  "no", "yes", "also", "still", "even", "some", "any", "all", "more",
  "most", "much", "own", "like", "want", "wants", "need", "needs", "get",
  "gets", "make", "makes", "thing", "things", "way", "what", "when",
  "where", "which", "who", "how", "why", "because", "while", "keep",
  "keeps", "going", "back", "actually", "basically", "maybe", "probably",
  "think", "thinking", "feel", "feels", "mean", "means", "guess", "know",
  "right", "okay", "ok", "um", "uh", "yeah", "well", "now", "one", "two",
  "something", "someone", "everything", "anything", "nothing", "lot",
  "important", "part", "whole", "bit", "us", "let", "lets", "let's",
]);

const LEADING_FILLERS = [
  /^(so|and|but|okay|ok|well|yeah|right|anyway|i mean|you know|like)[,\s]+/i,
  /^(i (?:think|feel|guess|mean|know|wonder)|it seems like|it feels like|the (?:important|key) (?:part|thing) is)(?: that)?[,\s]+/i,
  /^(i keep coming back to(?: the idea that)?|what i(?:'m| am) (?:saying|getting at) is)[,\s]+/i,
  /^(maybe|basically|honestly|actually)[,\s]+/i,
];

const MAX_IDEAS_PER_UTTERANCE = 3;
const MIN_WINDOW = 3;
const MAX_WINDOW = 6;

function tokenize(text, baseOffset = 0) {
  const tokens = [];
  const pattern = /[A-Za-z0-9][A-Za-z0-9''-]*/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const word = match[0];
    tokens.push({
      word,
      lower: word.toLowerCase().replace(/[''‑]/g, "'"),
      start: baseOffset + match.index,
      end: baseOffset + match.index + word.length,
      informative: !STOPWORDS.has(word.toLowerCase()),
    });
  }
  return tokens;
}

export function informativeTokens(text) {
  return new Set(
    tokenize(String(text))
      .filter((token) => token.informative)
      .map((token) => stem(token.lower)),
  );
}

// Tiny suffix stemmer so "mapping"/"maps"/"map" count as the same idea word.
function stem(word) {
  return word
    .replace(/'(s|re|ve|ll|d)$/, "")
    .replace(/(ing|ers|er|ed|es|s)$/, (suffix, offset) => (offset >= 3 ? "" : suffix));
}

export function overlapScore(setA, setB) {
  let score = 0;
  setA.forEach((token) => {
    if (setB.has(token)) score += 1;
  });
  return score;
}

function splitClauses(text) {
  const clauses = [];
  const sentencePattern = /[^.!?\n]+[.!?\n]*/g;
  let match;
  while ((match = sentencePattern.exec(text)) !== null) {
    const sentence = match[0];
    const base = match.index;
    const connector = /,?\s+(?:and then|and|but|so|because|which means)\s+/gi;
    let cursor = 0;
    let piece;
    const pieces = [];
    while ((piece = connector.exec(sentence)) !== null) {
      pieces.push({ text: sentence.slice(cursor, piece.index), start: base + cursor });
      cursor = piece.index + piece[0].length;
    }
    pieces.push({ text: sentence.slice(cursor), start: base + cursor });
    // Only keep a split if both sides carry enough content to be ideas.
    const informativeCounts = pieces.map((candidate) => (
      tokenize(candidate.text).filter((token) => token.informative).length
    ));
    if (pieces.length > 1 && informativeCounts.every((count) => count >= 3)) {
      clauses.push(...pieces);
    } else {
      clauses.push({ text: sentence, start: base });
    }
  }
  return clauses;
}

function condenseClause(clause) {
  let { text, start } = clause;
  for (const filler of LEADING_FILLERS) {
    const stripped = text.replace(filler, "");
    start += text.length - stripped.length;
    text = stripped;
  }
  const tokens = tokenize(text, start);
  if (tokens.filter((token) => token.informative).length < 2) return null;

  let best = null;
  for (let size = MIN_WINDOW; size <= Math.min(MAX_WINDOW, tokens.length); size += 1) {
    for (let index = 0; index + size <= tokens.length; index += 1) {
      let window = tokens.slice(index, index + size);
      while (window.length && !window[0].informative) window = window.slice(1);
      while (window.length && !window[window.length - 1].informative) window = window.slice(0, -1);
      if (window.length < 2) continue;
      const informative = window.filter((token) => token.informative).length;
      const score = informative - (window.length - informative) * 0.18;
      if (!best || score > best.score + 0.001) {
        best = { window, score };
      }
    }
  }
  if (!best) return null;
  const spanStart = best.window[0].start;
  const spanEnd = best.window[best.window.length - 1].end;
  return { spanStart, spanEnd };
}

export function condenseUtterance(text) {
  const source = String(text);
  const ideas = [];
  const seen = [];
  splitClauses(source).forEach((clause) => {
    if (ideas.length >= MAX_IDEAS_PER_UTTERANCE) return;
    const condensed = condenseClause(clause);
    if (!condensed) return;
    const quote = source.slice(condensed.spanStart, condensed.spanEnd);
    const label = quote.charAt(0).toUpperCase() + quote.slice(1);
    const tokens = informativeTokens(quote);
    if (seen.some((previous) => overlapScore(previous, tokens) >= tokens.size)) return;
    seen.push(tokens);
    ideas.push({ label, span: [condensed.spanStart, condensed.spanEnd], tokens });
  });
  return ideas;
}

