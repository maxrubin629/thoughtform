import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const SESSION_SCHEMA_VERSION = 1;
export const UNTITLED_SESSION_TITLE = "Untitled map";

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
]);
const ACTORS = new Set(["you", "partner", "curator"]);
const SPEAKERS = new Set(["you", "partner"]);
const PROPOSAL_STATUSES = new Set(["pending", "accepted", "dismissed", "stale"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export class SessionStoreError extends Error {
  constructor(message, { code = "session_store_error", status = 500, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export class SessionNotFoundError extends SessionStoreError {
  constructor(id) {
    super(`Session “${id}” was not found.`, {
      code: "session_not_found",
      status: 404,
      details: { session_id: id },
    });
  }
}

export class SessionSchemaError extends SessionStoreError {
  constructor(message, details) {
    super(message, { code: "invalid_session_schema", status: 422, details });
  }
}

export class SessionRevisionConflictError extends SessionStoreError {
  constructor(expected, session) {
    super(`Expected revision ${expected}, but the session is at revision ${session.revision}.`, {
      code: "revision_conflict",
      status: 409,
      details: {
        expected_revision: expected,
        current_revision: session.revision,
        snapshot: structuredClone(session),
      },
    });
    this.current_revision = session.revision;
    this.snapshot = structuredClone(session);
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
  assertObject(proposal, pathname);
  assertId(proposal.id, `${pathname}.id`);
  if (!PROPOSAL_STATUSES.has(proposal.status)) {
    schemaError(`${pathname}.status`, "must be pending, accepted, dismissed, or stale");
  }
  assertInteger(proposal.base_revision, `${pathname}.base_revision`);
  assertActor(proposal.actor, `${pathname}.actor`);
  assertString(proposal.rationale, `${pathname}.rationale`);
  if (!Array.isArray(proposal.evidence)) schemaError(`${pathname}.evidence`, "must be an array");
  proposal.evidence.forEach((item, index) => validateSource(item, `${pathname}.evidence[${index}]`, utterances));
  if (!Array.isArray(proposal.operations)) schemaError(`${pathname}.operations`, "must be an array");
  const operationIds = new Set();
  proposal.operations.forEach((operation, index) => {
    const operationPath = `${pathname}.operations[${index}]`;
    assertObject(operation, operationPath);
    assertId(operation.id, `${operationPath}.id`);
    assertString(operation.type, `${operationPath}.type`, { nonempty: true });
    if (operationIds.has(operation.id)) schemaError(`${operationPath}.id`, "must be unique within the proposal");
    operationIds.add(operation.id);
    if (operation.excluded !== undefined && typeof operation.excluded !== "boolean") {
      schemaError(`${operationPath}.excluded`, "must be a boolean when present");
    }
  });
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
  for (const key of Object.keys(session)) {
    if (!SESSION_KEYS.has(key)) schemaError(`session.${key}`, "is not part of schema version 1");
  }
  for (const key of SESSION_KEYS) {
    if (!(key in session)) schemaError(`session.${key}`, "is required");
  }

  assertId(session.id, "session.id");
  assertString(session.title, "session.title", { nonempty: true });
  assertInteger(session.revision, "session.revision");
  assertTimestamp(session.created_at, "session.created_at");
  assertTimestamp(session.updated_at, "session.updated_at");
  assertInteger(session.history_cursor, "session.history_cursor");

  if (!Array.isArray(session.transcript)) schemaError("session.transcript", "must be an array");
  const utterances = new Map();
  const realtimeItems = new Set();
  session.transcript.forEach((utterance, index) => {
    const pathname = `session.transcript[${index}]`;
    assertObject(utterance, pathname);
    assertId(utterance.id, `${pathname}.id`);
    if (utterances.has(utterance.id)) schemaError(`${pathname}.id`, "must be unique");
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
    utterances.set(utterance.id, utterance);
  });

  if (!Array.isArray(session.nodes)) schemaError("session.nodes", "must be an array");
  const nodeIds = new Set();
  session.nodes.forEach((node, index) => {
    const pathname = `session.nodes[${index}]`;
    assertObject(node, pathname);
    assertId(node.id, `${pathname}.id`);
    if (nodeIds.has(node.id)) schemaError(`${pathname}.id`, "must be unique");
    nodeIds.add(node.id);
    assertString(node.text, `${pathname}.text`, { nonempty: true });
    assertInteger(node.depth, `${pathname}.depth`);
    assertNumber(node.x, `${pathname}.x`);
    assertNumber(node.y, `${pathname}.y`);
    if (node.heat_at !== undefined) assertTimestamp(node.heat_at, `${pathname}.heat_at`);
    if (!Array.isArray(node.sources)) schemaError(`${pathname}.sources`, "must be an array");
    node.sources.forEach((source, sourceIndex) => (
      validateSource(source, `${pathname}.sources[${sourceIndex}]`, utterances)
    ));
    assertActor(node.created_by, `${pathname}.created_by`);
    assertTimestamp(node.created_at, `${pathname}.created_at`);
    assertTimestamp(node.updated_at, `${pathname}.updated_at`);
  });

  if (!Array.isArray(session.edges)) schemaError("session.edges", "must be an array");
  const edgeIds = new Set();
  session.edges.forEach((edge, index) => {
    const pathname = `session.edges[${index}]`;
    assertObject(edge, pathname);
    assertId(edge.id, `${pathname}.id`);
    if (edgeIds.has(edge.id)) schemaError(`${pathname}.id`, "must be unique");
    edgeIds.add(edge.id);
    assertId(edge.from, `${pathname}.from`);
    assertId(edge.to, `${pathname}.to`);
    if (edge.from === edge.to) schemaError(pathname, "must connect two different nodes");
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      schemaError(pathname, "must reference two existing nodes");
    }
    assertActor(edge.created_by, `${pathname}.created_by`);
    assertTimestamp(edge.created_at, `${pathname}.created_at`);
  });

  if (!Array.isArray(session.proposals)) schemaError("session.proposals", "must be an array");
  const proposalIds = new Set();
  session.proposals.forEach((proposal, index) => {
    validateProposal(proposal, `session.proposals[${index}]`, utterances);
    if (proposalIds.has(proposal.id)) schemaError(`session.proposals[${index}].id`, "must be unique");
    proposalIds.add(proposal.id);
  });

  if (!Array.isArray(session.operations)) schemaError("session.operations", "must be an array");
  const operationIds = new Set();
  session.operations.forEach((operation, index) => {
    const pathname = `session.operations[${index}]`;
    assertObject(operation, pathname);
    assertId(operation.id, `${pathname}.id`);
    if (operationIds.has(operation.id)) schemaError(`${pathname}.id`, "must be unique");
    operationIds.add(operation.id);
    assertString(operation.type, `${pathname}.type`, { nonempty: true });
    assertActor(operation.actor, `${pathname}.actor`);
    assertTimestamp(operation.created_at, `${pathname}.created_at`);
    if (operation.history_entry_ids !== undefined && !Array.isArray(operation.history_entry_ids)) {
      schemaError(`${pathname}.history_entry_ids`, "must be an array when present");
    }
  });
  const latestHistory = [...session.operations].reverse()
    .find((operation) => Array.isArray(operation.history_entry_ids))?.history_entry_ids ?? [];
  if (session.history_cursor > latestHistory.length) {
    schemaError("session.history_cursor", "must not exceed the current reversible history length");
  }
  return session;
}

function nowIso(now) {
  const value = typeof now === "function" ? now() : new Date();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeSessionId(id) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    throw new SessionStoreError("Invalid session ID.", { code: "invalid_session_id", status: 400 });
  }
  return id;
}

async function readJson(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new SessionSchemaError(`Could not parse ${path.basename(filename)} as JSON.`, {
        filename: path.basename(filename),
      });
    }
    throw error;
  }
}

async function atomicWriteJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export class SessionStore {
  constructor({
    directory = path.resolve(process.cwd(), "data/sessions"),
    now = () => new Date(),
    idFactory = () => randomUUID(),
  } = {}) {
    this.directory = path.resolve(directory);
    this.indexPath = path.join(this.directory, "_index.json");
    this.now = now;
    this.idFactory = idFactory;
    this.locks = new Map();
    this.initializing = null;
  }

  async init() {
    if (!this.initializing) {
      this.initializing = (async () => {
        await mkdir(this.directory, { recursive: true });
        const entries = await readdir(this.directory, { withFileTypes: true });
        await Promise.all(entries
          .filter((entry) => entry.isFile() && entry.name.startsWith(".") && entry.name.endsWith(".tmp"))
          .map((entry) => unlink(path.join(this.directory, entry.name)).catch(() => {})));
        const index = await readJson(this.indexPath);
        if (index === null) {
          await atomicWriteJson(this.indexPath, {
            schema_version: SESSION_SCHEMA_VERSION,
            active_session_id: null,
          });
        } else {
          this.#validateIndex(index);
        }
        return this;
      })().catch((error) => {
        this.initializing = null;
        throw error;
      });
    }
    return this.initializing;
  }

  #validateIndex(index) {
    assertObject(index, "session index");
    if (index.schema_version !== SESSION_SCHEMA_VERSION) {
      throw new SessionSchemaError("Unsupported session index schema version.", {
        found: index.schema_version,
        supported: SESSION_SCHEMA_VERSION,
      });
    }
    if (index.active_session_id !== null) assertId(index.active_session_id, "session index.active_session_id");
    return index;
  }

  #sessionPath(id) {
    return path.join(this.directory, `${safeSessionId(id)}.json`);
  }

  async #readIndex() {
    await this.init();
    return this.#validateIndex(await readJson(this.indexPath));
  }

  async #writeIndex(activeSessionId) {
    await atomicWriteJson(this.indexPath, {
      schema_version: SESSION_SCHEMA_VERSION,
      active_session_id: activeSessionId,
    });
  }

  async #exclusive(key, task) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => turn);
    this.locks.set(key, queued);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }

  async list() {
    await this.init();
    const entries = await readdir(this.directory, { withFileTypes: true });
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "_index.json") continue;
      const session = await readJson(path.join(this.directory, entry.name));
      validateSession(session);
      sessions.push({
        id: session.id,
        title: session.title,
        revision: session.revision,
        updated_at: session.updated_at,
        thought_count: session.nodes.length,
      });
    }
    const index = await this.#readIndex();
    sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return {
      active_session_id: sessions.some((session) => session.id === index.active_session_id)
        ? index.active_session_id
        : null,
      sessions,
    };
  }

  async listSessions() {
    return this.list();
  }

  async create({ title = UNTITLED_SESSION_TITLE, id } = {}) {
    await this.init();
    const timestamp = nowIso(this.now);
    const requestedId = id ? safeSessionId(id) : null;
    let sessionId = requestedId;
    let available = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      sessionId ??= safeSessionId(String(this.idFactory("session")));
      if (await readJson(this.#sessionPath(sessionId)) === null) {
        available = true;
        break;
      }
      if (requestedId) {
        throw new SessionStoreError(`Session “${sessionId}” already exists.`, {
          code: "session_already_exists",
          status: 409,
        });
      }
      sessionId = null;
    }
    if (!sessionId || !available) throw new SessionStoreError("Could not allocate a unique session ID.");
    const cleanTitle = String(title).trim();
    if (!cleanTitle) throw new SessionStoreError("Session title cannot be empty.", { code: "invalid_title", status: 400 });
    const session = {
      schema_version: SESSION_SCHEMA_VERSION,
      id: sessionId,
      title: cleanTitle,
      revision: 0,
      created_at: timestamp,
      updated_at: timestamp,
      transcript: [],
      nodes: [],
      edges: [],
      proposals: [],
      operations: [],
      history_cursor: 0,
    };
    validateSession(session);
    await atomicWriteJson(this.#sessionPath(sessionId), session);
    await this.#writeIndex(sessionId);
    return structuredClone(session);
  }

  async createSession(input) {
    return this.create(input);
  }

  async get(id) {
    await this.init();
    const session = await readJson(this.#sessionPath(id));
    if (!session) throw new SessionNotFoundError(id);
    validateSession(session);
    return structuredClone(session);
  }

  async getSession(id) {
    return this.get(id);
  }

  async setActive(id) {
    if (id !== null) await this.get(id);
    await this.#writeIndex(id);
    return id;
  }

  async resume({ createIfEmpty = false } = {}) {
    const index = await this.#readIndex();
    if (index.active_session_id) {
      try {
        return await this.get(index.active_session_id);
      } catch (error) {
        if (!(error instanceof SessionNotFoundError)) throw error;
      }
    }
    const { sessions } = await this.list();
    if (sessions[0]) {
      await this.#writeIndex(sessions[0].id);
      return this.get(sessions[0].id);
    }
    return createIfEmpty ? this.create() : null;
  }

  async resumeSession(options) {
    return this.resume(options);
  }

  async rename(id, title) {
    return this.#exclusive(`session:${id}`, async () => {
      const session = await this.get(id);
      const cleanTitle = String(title ?? "").trim();
      if (!cleanTitle) {
        throw new SessionStoreError("Session title cannot be empty.", { code: "invalid_title", status: 400 });
      }
      session.title = cleanTitle;
      session.updated_at = nowIso(this.now);
      validateSession(session);
      await atomicWriteJson(this.#sessionPath(id), session);
      await this.#writeIndex(id);
      return structuredClone(session);
    });
  }

  async renameSession(id, title) {
    return this.rename(id, title);
  }

  async delete(id) {
    return this.#exclusive(`session:${id}`, async () => {
      await this.get(id);
      await unlink(this.#sessionPath(id));
      const index = await this.#readIndex();
      if (index.active_session_id === id) {
        const { sessions } = await this.list();
        await this.#writeIndex(sessions[0]?.id ?? null);
      }
      return { deleted: true, id };
    });
  }

  async deleteSession(id) {
    return this.delete(id);
  }

  async save(session, { expectedRevision } = {}) {
    validateSession(session);
    return this.#exclusive(`session:${session.id}`, async () => {
      const current = await this.get(session.id);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new SessionRevisionConflictError(expectedRevision, current);
      }
      await atomicWriteJson(this.#sessionPath(session.id), session);
      await this.#writeIndex(session.id);
      return structuredClone(session);
    });
  }

  async saveSession(session, options) {
    return this.save(session, options);
  }

  async transact(id, transform) {
    return this.#exclusive(`session:${id}`, async () => {
      const current = await this.get(id);
      const outcome = await transform(structuredClone(current));
      const next = outcome?.session ?? outcome;
      if (!next || typeof next !== "object") {
        throw new SessionStoreError("A session transaction must return a session or { session }.");
      }
      validateSession(next);
      await atomicWriteJson(this.#sessionPath(id), next);
      await this.#writeIndex(id);
      if (outcome?.session) return { ...outcome, session: structuredClone(next) };
      return structuredClone(next);
    });
  }
}

export function createSessionStore(options) {
  return new SessionStore(options);
}
