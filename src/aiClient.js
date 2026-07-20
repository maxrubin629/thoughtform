async function post(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("AI server is unavailable — restart npm run dev");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status >= 500 && !data?.error) {
      throw new Error("AI server is unavailable — restart npm run dev");
    }
    throw new Error(data?.error ?? `AI server error (${response.status})`);
  }
  return data;
}

export async function requestProposals({ graph, prompt, selectedId }) {
  const { proposals } = await post("/api/propose", { graph, prompt, selectedId });
  return proposals ?? [];
}

export async function requestDictation(transcript) {
  const { thought } = await post("/api/dictate", { transcript });
  return thought;
}

export async function requestCompanion(graph) {
  return post("/api/companion", { graph });
}

export async function requestSynthesis(graph) {
  const { synthesis } = await post("/api/synthesize", { graph });
  return synthesis;
}
