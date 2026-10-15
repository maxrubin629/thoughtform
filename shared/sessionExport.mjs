export function sessionMarkdown(session) {
  const clean = (text) => String(text ?? "").replaceAll("\r", "");
  const lines = [`# ${clean(session.title)}`, "", `Saved ${session.updated_at} · map revision ${session.revision}`, ""];
  if (session.synthesis?.text) {
    lines.push("## Synthesis", "", clean(session.synthesis.text), "");
    if (session.synthesis.revision !== session.revision) lines.push(`Written from revision ${session.synthesis.revision}; the map has changed since.`, "");
  }
  lines.push("## Thoughts", "");
  for (const node of session.nodes) {
    lines.push(`### ${clean(node.text)}`, "");
    if (node.parked) lines.push("Kept aside.", "");
    for (const source of node.sources ?? []) {
      const id = source.utterance_id ?? source.utteranceId;
      const utterance = session.transcript.find((item) => item.id === id);
      const start = source.start ?? source.span?.[0];
      const end = source.end ?? source.span?.[1];
      if (utterance && Number.isInteger(start) && Number.isInteger(end)) {
        lines.push(`> ${clean(utterance.text.slice(start, end)).replaceAll("\n", "\n> ")}`, "", `Source: ${utterance.speaker === "you" ? "You" : "Partner"}, ${utterance.completed_at}`, "");
      }
    }
    const neighbors = session.edges.filter((edge) => edge.from === node.id).map((edge) => session.nodes.find((item) => item.id === edge.to)?.text).filter(Boolean);
    if (neighbors.length) lines.push(`Connected to: ${neighbors.map(clean).join("; ")}`, "");
  }
  lines.push("## Conversation", "");
  for (const utterance of session.transcript) lines.push(`**${utterance.speaker === "you" ? "You" : "Partner"}** · ${utterance.completed_at}`, "", clean(utterance.text), "");
  const consumed = new Set(session.live_capture?.consumed_fragment_ids ?? []);
  const pending = (session.transcript_fragments ?? []).filter((fragment) => !consumed.has(fragment.id));
  if (pending.length) {
    lines.push("## Unfinished speech", "", "These original fragments have not become complete mapped thoughts.", "");
    for (const fragment of pending) lines.push(`${fragment.speaker === "you" ? "You" : "Partner"}: ${clean(fragment.delta)}`, "");
  }
  return lines.join("\n");
}
