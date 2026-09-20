import { defaultLiveCapture, validateLiveStorage } from "./liveState.mjs";
import { SESSION_SCHEMA_VERSION, ACTORS, OPERATION_ORIGINS, SPEAKERS, SAFE_ID } from "./session/constants.mjs";
export { SESSION_SCHEMA_VERSION, UNTITLED_SESSION_TITLE, SAFE_ID } from "./session/constants.mjs";

const SESSION_KEYS = new Set([
  "schema_version",
  "id",
  "title",
  "revision",
  "created_at",
  "updated_at",
  "transcript",
  "nodes",
  "edges",
  "proposals",
  "operations",
  "history_cursor",
  "map_controller",
]);
const V1_SESSION_KEYS = new Set([...SESSION_KEYS].filter((key) => key !== "map_controller"));
const SESSION_EXTENSION_KEYS = new Set(["preferences", "synthesis", "transcript_fragments", "live_capture"]);
const INDEX_KEYS = new Set(["schema_version", "active_session_id"]);
const MAP_CONTROLLER_KEYS = new Set([
  "processed_transcript_count",
  "last_run_id",
  "last_success_at",
  "last_error",
]);
const PROPOSAL_STATUSES = new Set(["pending", "accepted", "dismissed", "stale"]);

export class SessionStoreError extends Error {
  constructor(message, { code = "session_store_error", status = 500, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export class SessionSchemaError extends SessionStoreError {
  constructor(message, details) {
    super(message, { code: "invalid_session_schema", status: 422, details });
  }
}

function schemaError(pathname, expectation) {
  throw new SessionSchemaError(`${pathname} ${expectation}.`, { path: pathname, expectation });
}

function assertObject(value, pathname) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    schemaError(pathname, "must be an object");
  }
}

function assertString(value, pathname, { nonempty = false } = {}) {
  if (typeof value !== "string" || (nonempty && !value.trim())) {
    schemaError(pathname, nonempty ? "must be a non-empty string" : "must be a string");
  }
}

function assertNumber(value, pathname) {
  if (!Number.isFinite(value)) schemaError(pathname, "must be a finite number");
}

function assertInteger(value, pathname, { minimum = 0 } = {}) {
  if (!Number.isInteger(value) || value < minimum) {
    schemaError(pathname, `must be an integer greater than or equal to ${minimum}`);
  }
}

function assertId(value, pathname) {
  assertString(value, pathname, { nonempty: true });
  if (!SAFE_ID.test(value)) schemaError(pathname, "must contain only letters, numbers, underscores, and hyphens");
}

function assertTimestamp(value, pathname) {
  assertString(value, pathname, { nonempty: true });
  if (Number.isNaN(Date.parse(value))) schemaError(pathname, "must be an ISO-compatible timestamp");
}

function assertActor(value, pathname) {
  if (!ACTORS.has(value)) schemaError(pathname, "must be you, partner, or curator");
}

function assertNullableString(value, pathname) {
  if (value !== null) assertString(value, pathname, { nonempty: true });
}

function assertNullableTimestamp(value, pathname) {
  if (value !== null) assertTimestamp(value, pathname);
}

function validateMapController(controller, pathname, transcriptLength) {
  assertKeys(controller, MAP_CONTROLLER_KEYS, pathname, "the map controller checkpoint");
  assertInteger(controller.processed_transcript_count, `${pathname}.processed_transcript_count`);
  if (controller.processed_transcript_count > transcriptLength) {
    schemaError(`${pathname}.processed_transcript_count`, "must not exceed the completed transcript length");
  }
  assertNullableString(controller.last_run_id, `${pathname}.last_run_id`);
  assertNullableTimestamp(controller.last_success_at, `${pathname}.last_success_at`);
  if (controller.last_error === null) return;
  assertKeys(controller.last_error, new Set(["code", "message", "at"]), `${pathname}.last_error`, "the controller error");
  assertString(controller.last_error.code, `${pathname}.last_error.code`, { nonempty: true });
  assertString(controller.last_error.message, `${pathname}.last_error.message`, { nonempty: true });
  assertTimestamp(controller.last_error.at, `${pathname}.last_error.at`);
}

export function defaultMapController(transcriptLength = 0) {
  return {
    processed_transcript_count: transcriptLength,
    last_run_id: null,
    last_success_at: null,
    last_error: null,
  };
}

function assertKeys(value, keys, pathname, description, optional = new Set()) {
  assertObject(value, pathname);
  for (const key of Object.keys(value)) {
    if (!keys.has(key) && !optional.has(key)) schemaError(`${pathname}.${key}`, `is not part of ${description}`);
  }
  for (const key of keys) {
    if (!(key in value)) schemaError(`${pathname}.${key}`, "is required");
  }
}

function validateArray(items, pathname, validate) {
  if (!Array.isArray(items)) schemaError(pathname, "must be an array");
  items.forEach((item, index) => validate(item, `${pathname}[${index}]`));
}

function validateRecords(items, pathname, validate, uniqueness = "must be unique") {
  const records = new Map();
  validateArray(items, pathname, (item, itemPath) => {
    assertObject(item, itemPath);
    assertId(item.id, `${itemPath}.id`);
    if (records.has(item.id)) schemaError(`${itemPath}.id`, uniqueness);
    validate(item, itemPath);
    records.set(item.id, item);
  });
  return records;
}

function migrateOperationRecord(operation) {
  const migrated = {
    ...operation,
    origin: operation.origin ?? (operation.actor === "partner" ? "realtime" : "ui"),
  };
  if (migrated.utterance_id && !migrated.source_utterance_ids) {
    migrated.source_utterance_ids = [migrated.utterance_id];
  }
  if (migrated.realtime_item_id && !migrated.source_realtime_item_id) {
    migrated.source_realtime_item_id = migrated.realtime_item_id;
  }
  return migrated;
}

export function migrateSession(session) {
  assertObject(session, "session");
  if (session.schema_version === SESSION_SCHEMA_VERSION) return { session, migrated: false };
  if (session.schema_version !== 1 && session.schema_version !== 2) {
    throw new SessionSchemaError(
      `Unsupported session schema version ${String(session.schema_version)}; expected ${SESSION_SCHEMA_VERSION}.`,
      { found: session.schema_version, supported: SESSION_SCHEMA_VERSION },
    );
  }
  assertKeys(session, session.schema_version === 1 ? V1_SESSION_KEYS : SESSION_KEYS, "session", `schema version ${session.schema_version}`);
  if (!Array.isArray(session.transcript)) schemaError("session.transcript", "must be an array");
  if (!Array.isArray(session.operations)) schemaError("session.operations", "must be an array");
  return {
    migrated: true,
    session: {
      ...session,
      schema_version: SESSION_SCHEMA_VERSION,
      operations: session.operations.map(migrateOperationRecord),
      map_controller: session.map_controller ?? defaultMapController(session.transcript.length),
      preferences: { mapping_paused: false, partner_mode: "proactive" },
      synthesis: null,
      transcript_fragments: [],
      live_capture: defaultLiveCapture(),
    },
  };
}

export function migrateIndex(index) {
  assertObject(index, "session index");
  if (index.schema_version === SESSION_SCHEMA_VERSION) return { index, migrated: false };
  if (index.schema_version !== 1 && index.schema_version !== 2) {
    throw new SessionSchemaError("Unsupported session index schema version.", {
      found: index.schema_version,
      supported: SESSION_SCHEMA_VERSION,
    });
  }
  assertKeys(index, INDEX_KEYS, "session index", "schema version 1");
  return {
    migrated: true,
    index: { ...index, schema_version: SESSION_SCHEMA_VERSION },
  };
}

function validateSource(source, pathname, utterances) {
  assertObject(source, pathname);
  assertId(source.utterance_id, `${pathname}.utterance_id`);
  assertInteger(source.start, `${pathname}.start`);
  assertInteger(source.end, `${pathname}.end`);
  assertString(source.quote, `${pathname}.quote`);
  if (source.end < source.start) schemaError(`${pathname}.end`, "must not precede start");
  const utterance = utterances.get(source.utterance_id);
  if (!utterance) schemaError(`${pathname}.utterance_id`, "must reference a transcript utterance");
  if (source.end > utterance.text.length || utterance.text.slice(source.start, source.end) !== source.quote) {
    schemaError(pathname, "must contain an exact character span from its transcript utterance");
  }
}

function validateProposal(proposal, pathname, utterances) {
  if (!PROPOSAL_STATUSES.has(proposal.status)) {
    schemaError(`${pathname}.status`, "must be pending, accepted, dismissed, or stale");
  }
  assertInteger(proposal.base_revision, `${pathname}.base_revision`);
  assertActor(proposal.actor, `${pathname}.actor`);
  assertString(proposal.rationale, `${pathname}.rationale`);
  validateArray(proposal.evidence, `${pathname}.evidence`, (source, sourcePath) => validateSource(source, sourcePath, utterances));
  validateRecords(proposal.operations, `${pathname}.operations`, (operation, operationPath) => {
    assertString(operation.type, `${operationPath}.type`, { nonempty: true });
    if (operation.excluded !== undefined && typeof operation.excluded !== "boolean") {
      schemaError(`${operationPath}.excluded`, "must be a boolean when present");
    }
  }, "must be unique within the proposal");
  assertTimestamp(proposal.created_at, `${pathname}.created_at`);
}

/**
 * Validate a deserialized canonical session. This intentionally rejects an
 * unknown top-level shape instead of silently migrating it; schema migrations
 * must be explicit so locally persisted maps are never partially interpreted.
 */
export function validateSession(session) {
  assertObject(session, "session");
  if (session.schema_version !== SESSION_SCHEMA_VERSION) {
    throw new SessionSchemaError(
      `Unsupported session schema version ${String(session.schema_version)}; expected ${SESSION_SCHEMA_VERSION}.`,
      { found: session.schema_version, supported: SESSION_SCHEMA_VERSION },
    );
  }
  assertKeys(session, SESSION_KEYS, "session", `schema version ${SESSION_SCHEMA_VERSION}`, SESSION_EXTENSION_KEYS);

  assertId(session.id, "session.id");
  assertString(session.title, "session.title", { nonempty: true });
  assertInteger(session.revision, "session.revision");
  assertTimestamp(session.created_at, "session.created_at");
  assertTimestamp(session.updated_at, "session.updated_at");
  assertInteger(session.history_cursor, "session.history_cursor");
  if (session.preferences !== undefined) {
    assertObject(session.preferences, "session.preferences");
    if (typeof session.preferences.mapping_paused !== "boolean") schemaError("session.preferences.mapping_paused", "must be a boolean");
    if (!["quiet", "proactive"].includes(session.preferences.partner_mode)) schemaError("session.preferences.partner_mode", "must be quiet or proactive");
    if (Object.keys(session.preferences).some((key) => !["mapping_paused", "partner_mode"].includes(key))) schemaError("session.preferences", "contains an unknown preference");
  }
  if (session.synthesis !== undefined && session.synthesis !== null) {
    assertObject(session.synthesis, "session.synthesis");
    assertString(session.synthesis.text, "session.synthesis.text", { nonempty: true });
    assertInteger(session.synthesis.revision, "session.synthesis.revision");
    if (session.synthesis.revision > session.revision) schemaError("session.synthesis.revision", "must reference an existing map revision");
    assertTimestamp(session.synthesis.created_at, "session.synthesis.created_at");
  }
  try { validateLiveStorage(session); } catch (error) { schemaError("session.live_capture", error.message); }

  const realtimeItems = new Set();
  const utterances = validateRecords(session.transcript, "session.transcript", (utterance, pathname) => {
    if (utterance.realtime_item_id !== undefined) {
      assertString(utterance.realtime_item_id, `${pathname}.realtime_item_id`, { nonempty: true });
      if (realtimeItems.has(utterance.realtime_item_id)) {
        schemaError(`${pathname}.realtime_item_id`, "must be unique when present");
      }
      realtimeItems.add(utterance.realtime_item_id);
    }
    if (!SPEAKERS.has(utterance.speaker)) schemaError(`${pathname}.speaker`, "must be you or partner");
    assertString(utterance.text, `${pathname}.text`, { nonempty: true });
    assertTimestamp(utterance.completed_at, `${pathname}.completed_at`);
  });
  validateMapController(session.map_controller, "session.map_controller", session.transcript.length);

  const nodes = validateRecords(session.nodes, "session.nodes", (node, pathname) => {
    assertString(node.text, `${pathname}.text`, { nonempty: true });
    assertInteger(node.depth, `${pathname}.depth`);
    assertNumber(node.x, `${pathname}.x`);
    assertNumber(node.y, `${pathname}.y`);
    if (node.heat_at !== undefined) assertTimestamp(node.heat_at, `${pathname}.heat_at`);
    for (const flag of ["pinned", "parked"]) {
      if (node[flag] !== undefined && typeof node[flag] !== "boolean") schemaError(`${pathname}.${flag}`, "must be a boolean");
    }
    validateArray(node.sources, `${pathname}.sources`, (source, sourcePath) => validateSource(source, sourcePath, utterances));
    assertActor(node.created_by, `${pathname}.created_by`);
    assertTimestamp(node.created_at, `${pathname}.created_at`);
    assertTimestamp(node.updated_at, `${pathname}.updated_at`);
  });

  validateRecords(session.edges, "session.edges", (edge, pathname) => {
    assertId(edge.from, `${pathname}.from`);
    assertId(edge.to, `${pathname}.to`);
    if (edge.from === edge.to) schemaError(pathname, "must connect two different nodes");
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      schemaError(pathname, "must reference two existing nodes");
    }
    assertActor(edge.created_by, `${pathname}.created_by`);
    assertTimestamp(edge.created_at, `${pathname}.created_at`);
  });

  validateRecords(session.proposals, "session.proposals", (proposal, pathname) => validateProposal(proposal, pathname, utterances));

  validateRecords(session.operations, "session.operations", (operation, pathname) => {
    assertString(operation.type, `${pathname}.type`, { nonempty: true });
    assertActor(operation.actor, `${pathname}.actor`);
    if (!OPERATION_ORIGINS.has(operation.origin)) {
      schemaError(`${pathname}.origin`, "must be ui, realtime, or map_controller");
    }
    if ((operation.origin === "realtime" || operation.origin === "map_controller")
      && operation.actor !== "partner") {
      schemaError(`${pathname}.actor`, "must be partner for realtime or map_controller operations");
    }
    if (operation.source_utterance_ids !== undefined) {
      if (!Array.isArray(operation.source_utterance_ids)) {
        schemaError(`${pathname}.source_utterance_ids`, "must be an array when present");
      }
      const sourceUtteranceIds = new Set();
      operation.source_utterance_ids.forEach((id, sourceIndex) => {
        assertId(id, `${pathname}.source_utterance_ids[${sourceIndex}]`);
        if (!utterances.has(id)) schemaError(`${pathname}.source_utterance_ids[${sourceIndex}]`, "must reference a transcript utterance");
        if (sourceUtteranceIds.has(id)) schemaError(`${pathname}.source_utterance_ids[${sourceIndex}]`, "must not contain duplicates");
        sourceUtteranceIds.add(id);
      });
    }
    if (operation.source_realtime_item_id !== undefined) {
      assertString(operation.source_realtime_item_id, `${pathname}.source_realtime_item_id`, { nonempty: true });
      if (!realtimeItems.has(operation.source_realtime_item_id)) {
        schemaError(`${pathname}.source_realtime_item_id`, "must reference a transcript realtime item");
      }
    }
    assertTimestamp(operation.created_at, `${pathname}.created_at`);
    if (operation.history_entry_ids !== undefined && !Array.isArray(operation.history_entry_ids)) {
      schemaError(`${pathname}.history_entry_ids`, "must be an array when present");
    }
  });
  const latestHistory = session.operations.findLast((operation) => Array.isArray(operation.history_entry_ids))?.history_entry_ids ?? [];
  if (session.history_cursor > latestHistory.length) {
    schemaError("session.history_cursor", "must not exceed the current reversible history length");
  }
  return session;
}

export function validateIndex(index) {
  assertObject(index, "session index");
  if (index.schema_version !== SESSION_SCHEMA_VERSION) {
    throw new SessionSchemaError("Unsupported session index schema version.", {
      found: index.schema_version,
      supported: SESSION_SCHEMA_VERSION,
    });
  }
  assertKeys(index, INDEX_KEYS, "session index", `schema version ${SESSION_SCHEMA_VERSION}`);
  if (index.active_session_id !== null) assertId(index.active_session_id, "session index.active_session_id");
  return index;
}
