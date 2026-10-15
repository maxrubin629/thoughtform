import { DEFAULT_REASONING_EFFORT, DEFAULT_REASONING_MODEL } from "./modelConfig.mjs";
import { DEFAULT_LIVE_BACKEND_MODEL, DEFAULT_LIVE_MODEL } from "./liveCapture.mjs";
import { DEFAULT_MAP_CONTROLLER_MODEL } from "./mapControllerProtocol.mjs";
import { isCuratorEnabled } from "./curator.mjs";

/** Read every server setting from one environment object. Blank values use defaults. */
export function resolveServerConfig(env = process.env) {
  const read = (name, fallback) => {
    const value = env[name];
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  };
  return {
    port: Number(read("PORT", 8787)),
    dataDirectory: read("THOUGHTFORM_DATA_DIR", null),
    apiKey: read("OPENAI_API_KEY", null),
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    models: {
      synthesis: read("OPENAI_MODEL", DEFAULT_REASONING_MODEL),
      live: read("OPENAI_LIVE_MODEL", DEFAULT_LIVE_MODEL),
      liveBackend: read("OPENAI_LIVE_BACKEND_MODEL", DEFAULT_LIVE_BACKEND_MODEL),
      mapController: read("OPENAI_MAP_CONTROLLER_MODEL", DEFAULT_MAP_CONTROLLER_MODEL),
      curator: read("OPENAI_CURATOR_MODEL", DEFAULT_REASONING_MODEL),
    },
    mapControllerEnabled: env.THOUGHTFORM_MAP_CONTROLLER_ENABLED !== "false",
    curatorEnabled: isCuratorEnabled(env),
  };
}
