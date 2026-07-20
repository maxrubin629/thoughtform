const nodeText = (node) => node.lines.join(" ");

export function serializeGraph(nodes, edges) {
  const committed = nodes.filter((node) => !node.ghost);
  const ids = new Set(committed.map((node) => node.id));
  return {
    thoughts: committed.map((node) => ({
      id: node.id,
      text: nodeText(node),
      provenance: node.provenance ?? "seed",
    })),
    links: edges
      .filter((edge) => !edge.ghost && ids.has(edge.from) && ids.has(edge.to))
      .map((edge) => ({ from: edge.from, to: edge.to })),
    pending_proposals: nodes.filter((node) => node.ghost).map(nodeText),
  };
}
