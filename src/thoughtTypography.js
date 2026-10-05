const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function graphemes(text) {
  return graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment)
    : Array.from(text);
}

function wrapIntoLines(words, widths, measure) {
  const lines = [];
  let wordIndex = 0;
  let remainder = "";

  for (const width of widths) {
    let line = "";
    while (wordIndex < words.length || remainder) {
      const word = remainder || words[wordIndex];
      const next = line ? `${line} ${word}` : word;
      if (measure(next) <= width) {
        line = next;
        if (remainder) remainder = "";
        else wordIndex += 1;
        continue;
      }
      if (line) break;

      // An oversized word may wrap, but an emoji or combining sequence cannot.
      const parts = graphemes(word);
      let taken = 0;
      while (taken < parts.length && measure(line + parts[taken]) <= width) {
        line += parts[taken];
        taken += 1;
      }
      if (!remainder) wordIndex += 1;
      remainder = parts.slice(taken).join("");
      break;
    }
    lines.push(line);
    if (wordIndex === words.length && !remainder) break;
  }

  return { lines, truncated: wordIndex < words.length || Boolean(remainder) };
}

function withEllipsis(text, width, measure) {
  const parts = graphemes(text);
  while (parts.length && measure(`${parts.join("").trimEnd()}…`) > width) parts.pop();
  return measure("…") <= width ? `${parts.join("").trimEnd()}…` : "";
}

/**
 * Return a presentation-only label. The caller centers its lines using lineHeight.
 * measureText(text, { fontSize, fontWeight }) returns a width or TextMetrics.
 * textOffsetY and footerTop are world units relative to the lobe center.
 * Typography depends on semantic root identity, never motion or connectivity.
 */
export function layoutThoughtLabel(node, { isRoot = false, measureText, textOffsetY = 0, footerTop = Infinity } = {}) {
  if (typeof measureText !== "function") throw new TypeError("A text measurement function is required.");

  const fontSize = isRoot ? 20 : 15;
  const fontWeight = isRoot ? 400 : 500;
  const lineHeight = fontSize * 1.25;
  const style = { fontSize, fontWeight };
  const measurements = new Map();
  const measure = (text) => {
    if (!measurements.has(text)) {
      const result = measureText(text, style);
      measurements.set(text, typeof result === "number" ? result : result.width);
    }
    return measurements.get(text);
  };
  const text = String(node.text ?? node.lines?.join(" ") ?? "").trim().replace(/\s+/gu, " ") || "New thought";
  const words = text.split(" ");
  const radius = Number.isFinite(node.r) && node.r > 0 ? node.r : 46;
  const innerRadius = Math.max(1, radius - Math.min(8, Math.max(4, radius * 0.1)));
  const availableHalfHeight = Math.min(innerRadius + textOffsetY, Math.min(innerRadius, footerTop) - textOffsetY);
  const maxLines = Math.max(1, Math.min(
    Math.floor((innerRadius * 1.3 - fontSize) / lineHeight) + 1,
    Math.floor(2 * (availableHalfHeight - fontSize * 0.6) / lineHeight) + 1,
  ));
  let result;

  for (let count = 1; count <= maxLines; count += 1) {
    // Keep the whole glyph box inside the circle, including the outermost lines.
    const widths = Array.from({ length: count }, (_, index) => {
      const y = Math.abs(textOffsetY + (index - (count - 1) / 2) * lineHeight) + fontSize * 0.6;
      return 2 * Math.sqrt(Math.max(0, innerRadius ** 2 - y ** 2));
    });
    result = wrapIntoLines(words, widths, measure);
    if (!result.truncated) break;
    if (count === maxLines) {
      const last = result.lines.length - 1;
      result.lines[last] = withEllipsis(result.lines[last], widths[last], measure);
    }
  }

  return { fontSize, fontWeight, lineHeight, ...result };
}
