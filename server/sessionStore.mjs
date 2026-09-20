import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { defaultLiveCapture } from "./liveState.mjs";
import {
  SESSION_SCHEMA_VERSION, UNTITLED_SESSION_TITLE, SAFE_ID,
  SessionStoreError, SessionSchemaError, defaultMapController,
  migrateIndex, migrateSession, validateIndex, validateSession,
} from "./sessionSchema.mjs";

export {
  SESSION_SCHEMA_VERSION, UNTITLED_SESSION_TITLE,
  SessionStoreError, SessionSchemaError, migrateSession, validateSession,
} from "./sessionSchema.mjs";

export class SessionNotFoundError extends SessionStoreError {
  constructor(id) {
    super(`Session “${id}” was not found.`, {
      code: "session_not_found",
      status: 404,
      details: { session_id: id },
    });
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
      },
    });
    this.current_revision = session.revision;
    this.snapshot = structuredClone(session);
  }
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
          const migrated = migrateIndex(index);
          validateIndex(migrated.index);
          if (migrated.migrated) await atomicWriteJson(this.indexPath, migrated.index);
        }
        return this;
      })().catch((error) => {
        this.initializing = null;
        throw error;
      });
    }
    return this.initializing;
  }

  async #readSessionFile(filename) {
    const raw = await readJson(filename);
    if (!raw) return null;
    const migrated = migrateSession(raw);
    validateSession(migrated.session);
    if (migrated.migrated) {
      // A migrated map can always be recovered with the earlier app version.
      const backup = `${filename}.v${raw.schema_version}.backup`;
      if (await readJson(backup) === null) await atomicWriteJson(backup, raw);
      await atomicWriteJson(filename, migrated.session);
    }
    return migrated.session;
  }

  #sessionPath(id) {
    return path.join(this.directory, `${safeSessionId(id)}.json`);
  }

  async #readIndex() {
    await this.init();
    const index = await readJson(this.indexPath);
    return validateIndex(index);
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
    const warnings = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "_index.json") continue;
      try {
        const session = await this.#readSessionFile(path.join(this.directory, entry.name));
        if (!session) continue;
        sessions.push({
          id: session.id,
          title: session.title,
          revision: session.revision,
          updated_at: session.updated_at,
          thought_count: session.nodes.length,
        });
      } catch (error) {
        if (!(error instanceof SessionSchemaError)) throw error;
        warnings.push({
          filename: entry.name,
          code: error?.code ?? "session_read_failed",
          message: error?.message ?? "The session could not be read.",
        });
      }
    }
    const index = await this.#readIndex();
    sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return {
      active_session_id: sessions.some((session) => session.id === index.active_session_id)
        ? index.active_session_id
        : null,
      sessions,
      warnings,
    };
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
      map_controller: defaultMapController(),
      preferences: { mapping_paused: false, partner_mode: "proactive" },
      synthesis: null,
      transcript_fragments: [],
      live_capture: defaultLiveCapture(),
    };
    validateSession(session);
    await atomicWriteJson(this.#sessionPath(sessionId), session);
    await this.#writeIndex(sessionId);
    return structuredClone(session);
  }

  async get(id) {
    await this.init();
    const session = await this.#readSessionFile(this.#sessionPath(id));
    if (!session) throw new SessionNotFoundError(id);
    return structuredClone(session);
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
        if (!(error instanceof SessionNotFoundError) && !(error instanceof SessionSchemaError)) throw error;
      }
    }
    const { sessions } = await this.list();
    if (sessions[0]) {
      await this.#writeIndex(sessions[0].id);
      return this.get(sessions[0].id);
    }
    return createIfEmpty ? this.create() : null;
  }

  async rename(id, title) {
    return this.transact(id, (session) => {
      const cleanTitle = String(title ?? "").trim();
      if (!cleanTitle) {
        throw new SessionStoreError("Session title cannot be empty.", { code: "invalid_title", status: 400 });
      }
      session.title = cleanTitle;
      session.updated_at = nowIso(this.now);
      return session;
    });
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

  async save(session, { expectedRevision } = {}) {
    validateSession(session);
    return this.transact(session.id, (current) => {
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new SessionRevisionConflictError(expectedRevision, current);
      }
      return session;
    });
  }

  async transact(id, transform) {
    return this.#exclusive(`session:${id}`, async () => {
      const current = await this.get(id);
      const outcome = await transform(current);
      const next = outcome?.session ?? outcome;
      if (!next || typeof next !== "object") {
        throw new SessionStoreError("A session transaction must return a session or { session }.");
      }
      validateSession(next);
      await atomicWriteJson(this.#sessionPath(id), next);
      if (outcome?.session) return { ...outcome, session: structuredClone(next) };
      return structuredClone(next);
    });
  }
}

export function createSessionStore(options) {
  return new SessionStore(options);
}
