import express from "express";
import OpenAI from "openai";
import {
  COMPANION_SCHEMA,
  COMPANION_SYSTEM,
  DICTATE_SYSTEM,
  DICTATION_SCHEMA,
  PROPOSAL_SCHEMA,
  PROPOSE_SYSTEM,
  SYNTHESIZE_SYSTEM,
} from "./prompts.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.6";
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const client = hasKey ? new OpenAI() : null;

const app = express();
app.use(express.json({ limit: "1mb" }));

const asJsonSchema = (name, schema) => ({
  format: { type: "json_schema", name, strict: true, schema },
});

async function structuredCall({ system, payload, schemaName, schema }) {
  const response = await client.responses.create({
    model: MODEL,
    reasoning: { effort: "low" },
    instructions: system,
    input: JSON.stringify(payload),
    text: asJsonSchema(schemaName, schema),
  });
  return JSON.parse(response.output_text);
}

const wrap = (handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: error?.message ?? "Model call failed" });
  }
};

app.get("/api/health", (req, res) => {
  res.json({ ok: true, model: MODEL, mock: !hasKey });
});

app.post("/api/propose", wrap(async (req) => {
  const { graph, prompt, selectedId } = req.body ?? {};
  if (!graph?.thoughts?.length || !prompt) throw new Error("propose needs { graph, prompt }");

  if (!hasKey) {
    const parent = graph.thoughts.find((t) => t.id === selectedId) ?? graph.thoughts[0];
    return {
      proposals: [{
        parent_id: parent.id,
        text: `Mock proposal for “${prompt.slice(0, 32)}”`,
        reason: "offline mock — set OPENAI_API_KEY",
      }],
    };
  }

  const { proposals } = await structuredCall({
    system: PROPOSE_SYSTEM,
    payload: { graph, selected_id: selectedId, request: prompt },
    schemaName: "proposals",
    schema: PROPOSAL_SCHEMA,
  });
  const validIds = new Set(graph.thoughts.map((t) => t.id));
  return {
    proposals: proposals
      .filter((p) => validIds.has(p.parent_id) && p.text?.trim())
      .slice(0, 3),
  };
}));

app.post("/api/dictate", wrap(async (req) => {
  const { transcript } = req.body ?? {};
  if (!transcript?.trim()) throw new Error("dictate needs { transcript }");

  if (!hasKey) return { thought: transcript.trim() };

  const { thought } = await structuredCall({
    system: DICTATE_SYSTEM,
    payload: { transcript },
    schemaName: "dictation",
    schema: DICTATION_SCHEMA,
  });
  return { thought };
}));

app.post("/api/companion", wrap(async (req) => {
  const { graph } = req.body ?? {};
  if (!graph?.thoughts?.length) throw new Error("companion needs { graph }");

  if (!hasKey) {
    return {
      line: "Keep going, this is getting interesting…",
      followup: "What if we explored the flow a bit more?",
    };
  }

  return structuredCall({
    system: COMPANION_SYSTEM,
    payload: { graph },
    schemaName: "companion",
    schema: COMPANION_SCHEMA,
  });
}));

app.post("/api/synthesize", wrap(async (req) => {
  const { graph } = req.body ?? {};
  if (!graph?.thoughts?.length) throw new Error("synthesize needs { graph }");

  if (!hasKey) {
    return { synthesis: `Offline mock synthesis of ${graph.thoughts.length} thoughts — set OPENAI_API_KEY to enable ${MODEL}.` };
  }

  const response = await client.responses.create({
    model: MODEL,
    reasoning: { effort: "low" },
    instructions: SYNTHESIZE_SYSTEM,
    input: JSON.stringify({ graph }),
  });
  return { synthesis: response.output_text.trim() };
}));

app.listen(PORT, () => {
  console.log(`thoughtform ai server on http://localhost:${PORT} (model: ${MODEL}${hasKey ? "" : ", MOCK MODE — no OPENAI_API_KEY"})`);
});
