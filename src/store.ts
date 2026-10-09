import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { branchKeyFromLeaf, type SessionTreeView } from "./branch.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

// "" targets the session scope; null targets the branch scope before the
// session tree has produced a key — such a value waits in memory only.
export interface StateKey {
  pluginId: string;
  sessionId: string;
  branchId: string | null;
}

type KeyedStateKey = {
  pluginId: string;
  sessionId: string;
  branchId: string;
};

type ValueEntry = { kind: "value"; json: string };
type CacheEntry = ValueEntry | { kind: "absent" };

// The read-only report the extension entry's commands render.
export interface SessionInspection {
  lock: { holder: string; acquiredAt: number } | undefined;
  rowsByPlugin: Array<{ pluginId: string; count: number }>;
}

type OpenState = {
  database: DatabaseSync;
  select: StatementSync;
  upsert: StatementSync;
  remove: StatementSync;
  lockInsert: StatementSync;
  lockSelect: StatementSync;
  lockUpdate: StatementSync;
  lockDelete: StatementSync;
  lockRelease: StatementSync;
  rowsByPlugin: StatementSync;
};

// The refusal carries its four elements in the message and as fields:
// initiator (the holder of the session lock), action, object (the session),
// and reason.
export class SessionWriteRefusedError extends Error {
  readonly action: "write" | "drop";
  readonly sessionId: string;
  readonly holder: string;

  constructor(action: "write" | "drop", sessionId: string, holder: string) {
    super(
      `session-state: ${action} refused — initiator: ${holder}; action: ${action}; object: session ${sessionId}; reason: one writer per session at a time`,
    );
    this.name = "SessionWriteRefusedError";
    this.action = action;
    this.sessionId = sessionId;
    this.holder = holder;
  }
}

const CREATE_STATE_TABLE = `CREATE TABLE IF NOT EXISTS state (
  plugin_id  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch_id  TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (plugin_id, session_id, branch_id)
)`;

const CREATE_LOCK_TABLE = `CREATE TABLE IF NOT EXISTS write_lock (
  session_id  TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  acquired_at INTEGER NOT NULL
)`;

const SELECT_ROW =
  "SELECT value FROM state WHERE plugin_id = ? AND session_id = ? AND branch_id = ?";
const UPSERT_ROW =
  "INSERT OR REPLACE INTO state (plugin_id, session_id, branch_id, value) VALUES (?, ?, ?, ?)";
const DELETE_ROW =
  "DELETE FROM state WHERE plugin_id = ? AND session_id = ? AND branch_id = ?";

const LOCK_INSERT =
  "INSERT OR IGNORE INTO write_lock (session_id, holder, acquired_at) VALUES (?, ?, ?)";
const LOCK_SELECT =
  "SELECT holder, acquired_at FROM write_lock WHERE session_id = ?";
const LOCK_UPDATE =
  "UPDATE write_lock SET holder = ?, acquired_at = ? WHERE session_id = ? AND holder = ? AND acquired_at = ?";
const LOCK_DELETE = "DELETE FROM write_lock WHERE session_id = ? AND holder = ?";
const LOCK_RELEASE = "DELETE FROM write_lock WHERE session_id = ?";
const ROWS_BY_PLUGIN =
  "SELECT plugin_id, COUNT(*) AS count FROM state WHERE session_id = ? GROUP BY plugin_id ORDER BY plugin_id";

// Cross-session contention waits on SQLite instead of failing immediately.
const BUSY_TIMEOUT_MS = 5000;

// The worst legitimate hold spans acquire, operate, and release, each of
// which may wait on SQLite up to BUSY_TIMEOUT_MS: 3 × 5s = 15s. 60s sits
// well above that; only a crash whose pid is later reused ages a row out.
const LOCK_LEASE_MS = 60_000;

function serializeValue(value: unknown): string {
  if (value === undefined) {
    throw new TypeError(
      "session-state: cannot store undefined; drop() removes a value instead",
    );
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new TypeError("session-state: value is not JSON-serializable", {
      cause: error,
    });
  }
  if (json === undefined) {
    throw new TypeError("session-state: value is not JSON-serializable");
  }
  return json;
}

function parseStored(json: string): JsonValue {
  try {
    return JSON.parse(json) as JsonValue;
  } catch (error) {
    throw new Error("session-state: corrupt JSON in the state database", {
      cause: error,
    });
  }
}

function cacheKeyOf(key: KeyedStateKey): string {
  return `${key.pluginId}\u0000${key.sessionId}\u0000${key.branchId}`;
}

function pendingKeyOf(pluginId: string, sessionId: string): string {
  return `${pluginId}\u0000${sessionId}`;
}

function holderOf(): string {
  return `pid:${process.pid}`;
}

function parseHolderPid(holder: string): number | null {
  const match = /^pid:(\d+)$/.exec(holder);
  return match === null ? null : Number(match[1]);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Whether the holder recorded in a lock row names a live process.
export type HolderStatus = "alive" | "not-alive" | "unknown";

// Whether the holder recorded in a lock row names a live process.
export function holderStatus(holder: string): HolderStatus {
  const pid = parseHolderPid(holder);
  if (pid === null) return "unknown";
  return isProcessAlive(pid) ? "alive" : "not-alive";
}

// store.ts -> key to row: SQLite reads and writes, an in-process cache, and
// the branch ascent. A branch read that misses the current key ascends run
// tops and, on its first hit, writes the value under the current key
// (materialization) before returning it. Explicit writes and drops hold a
// session-level lock (a write_lock row keyed by session) so a concurrent
// same-session writer is refused; a crash-left row is taken over once it
// ages past the lease. Cross-session contention waits on SQLite. Read-path
// writes (materialization, landing a keyless value) are lock-free so reads
// can proceed. The tree view needed by the ascent arrives as an argument;
// this module reads no context and no Pi.
export class SessionStore {
  readonly #path: string;
  #state: OpenState | undefined;
  readonly #cache = new Map<string, CacheEntry>();
  // Keyless branch writes, held until the context yields a key.
  readonly #pending = new Map<string, string>();

  constructor(databasePath: string) {
    this.#path = databasePath;
  }

  read(key: StateKey, tree: SessionTreeView | null): JsonValue | undefined {
    if (key.branchId === null) {
      const pending = this.#pending.get(pendingKeyOf(key.pluginId, key.sessionId));
      return pending === undefined ? undefined : parseStored(pending);
    }
    const keyed: KeyedStateKey = {
      pluginId: key.pluginId,
      sessionId: key.sessionId,
      branchId: key.branchId,
    };
    if (keyed.branchId !== "") this.#flushPending(keyed);

    const current = this.#load(keyed);
    if (current.kind === "value") return parseStored(current.json);
    if (tree === null) return undefined;

    const inherited = this.#ascend(keyed, tree);
    if (inherited === undefined) return undefined;
    this.#writeRow(keyed, inherited.json);
    return parseStored(inherited.json);
  }

  write(key: StateKey, value: unknown): void {
    const json = serializeValue(value);
    if (key.branchId === null) {
      this.#pending.set(pendingKeyOf(key.pluginId, key.sessionId), json);
      return;
    }
    const keyed: KeyedStateKey = {
      pluginId: key.pluginId,
      sessionId: key.sessionId,
      branchId: key.branchId,
    };
    this.#withLock(keyed.sessionId, "write", () => {
      this.#writeRow(keyed, json);
    });
    if (keyed.branchId !== "") {
      this.#pending.delete(pendingKeyOf(keyed.pluginId, keyed.sessionId));
    }
  }

  drop(key: StateKey): void {
    if (key.branchId === null) {
      this.#pending.delete(pendingKeyOf(key.pluginId, key.sessionId));
      return;
    }
    const keyed: KeyedStateKey = {
      pluginId: key.pluginId,
      sessionId: key.sessionId,
      branchId: key.branchId,
    };
    this.#withLock(keyed.sessionId, "drop", () => {
      const { remove } = this.#ready();
      remove.run(keyed.pluginId, keyed.sessionId, keyed.branchId);
      this.#cache.delete(cacheKeyOf(keyed));
    });
    if (keyed.branchId !== "") {
      this.#pending.delete(pendingKeyOf(keyed.pluginId, keyed.sessionId));
    }
  }

  // The extension entry's seam: a session's lock row can be released, this
  // process's cache for it dropped, and its contents inspected. The library
  // surface gains nothing.
  releaseSessionLock(sessionId: string): void {
    this.#ready().lockRelease.run(sessionId);
  }

  dropSessionCache(sessionId: string): void {
    for (const cacheKey of [...this.#cache.keys()]) {
      if (cacheKey.split("\u0000")[1] === sessionId) this.#cache.delete(cacheKey);
    }
  }

  inspectSession(sessionId: string): SessionInspection {
    if (this.#state === undefined && !existsSync(this.#path)) {
      return { lock: undefined, rowsByPlugin: [] };
    }
    const { lockSelect, rowsByPlugin } = this.#ready();
    const lockRow = lockSelect.get(sessionId) as
      | { holder: string; acquired_at: number }
      | undefined;
    const rows = rowsByPlugin.all(sessionId) as Array<{
      plugin_id: string;
      count: number;
    }>;
    return {
      lock:
        lockRow === undefined
          ? undefined
          : { holder: lockRow.holder, acquiredAt: lockRow.acquired_at },
      rowsByPlugin: rows.map((row) => ({
        pluginId: row.plugin_id,
        count: row.count,
      })),
    };
  }

  // A keyless value lands under the first key the context yields.
  #flushPending(key: KeyedStateKey): void {
    const pending = this.#pending.get(pendingKeyOf(key.pluginId, key.sessionId));
    if (pending === undefined) return;
    this.#writeRow(key, pending);
    this.#pending.delete(pendingKeyOf(key.pluginId, key.sessionId));
  }

  // The scope's first load queries the disk; afterwards the cache answers.
  #load(key: KeyedStateKey): CacheEntry {
    const cacheKey = cacheKeyOf(key);
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const { select } = this.#ready();
    const row = select.get(key.pluginId, key.sessionId, key.branchId) as
      | { value: string }
      | undefined;
    const entry: CacheEntry =
      row === undefined
        ? { kind: "absent" }
        : { kind: "value", json: row.value };
    this.#cache.set(cacheKey, entry);
    return entry;
  }

  #ascend(key: KeyedStateKey, tree: SessionTreeView): ValueEntry | undefined {
    let node = key.branchId;
    for (;;) {
      const parent = tree.parentOf(node);
      if (parent === null) return undefined;
      const parentKey = branchKeyFromLeaf(tree, parent);
      if (parentKey === null) return undefined;
      const entry = this.#load({
        pluginId: key.pluginId,
        sessionId: key.sessionId,
        branchId: parentKey,
      });
      if (entry.kind === "value") return entry;
      node = parentKey;
    }
  }

  #writeRow(key: KeyedStateKey, json: string): void {
    const { upsert } = this.#ready();
    upsert.run(key.pluginId, key.sessionId, key.branchId, json);
    this.#cache.set(cacheKeyOf(key), { kind: "value", json });
  }

  #withLock<T>(
    sessionId: string,
    action: "write" | "drop",
    operation: () => T,
  ): T {
    this.#acquire(sessionId, action);
    try {
      return operation();
    } finally {
      this.#release(sessionId);
    }
  }

  #acquire(sessionId: string, action: "write" | "drop"): void {
    const holder = holderOf();
    const now = Date.now();
    const { lockInsert, lockSelect, lockUpdate } = this.#ready();
    if (lockInsert.run(sessionId, holder, now).changes === 1) return;

    const existing = lockSelect.get(sessionId) as
      | { holder: string; acquired_at: number }
      | undefined;
    if (existing === undefined) {
      // Released between the insert and this read; one retry.
      if (lockInsert.run(sessionId, holder, now).changes === 1) return;
      throw new SessionWriteRefusedError(action, sessionId, "unknown");
    }

    const holderPid = parseHolderPid(existing.holder);
    const aged = now - existing.acquired_at > LOCK_LEASE_MS;
    const mayTakeOver =
      holderPid === process.pid ||
      (holderPid !== null && !isProcessAlive(holderPid)) ||
      aged;
    const took =
      mayTakeOver &&
      lockUpdate.run(holder, now, sessionId, existing.holder, existing.acquired_at)
        .changes === 1;
    if (took) return;

    const current =
      (lockSelect.get(sessionId) as { holder: string } | undefined) ?? existing;
    throw new SessionWriteRefusedError(action, sessionId, current.holder);
  }

  #release(sessionId: string): void {
    this.#ready().lockDelete.run(sessionId, holderOf());
  }

  #ready(): OpenState {
    const existing = this.#state;
    if (existing !== undefined) return existing;
    const state = this.#open();
    this.#state = state;
    return state;
  }

  #open(): OpenState {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const database = new DatabaseSync(this.#path);
      database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      database.exec("PRAGMA journal_mode = WAL");
      database.exec(CREATE_STATE_TABLE);
      database.exec(CREATE_LOCK_TABLE);
      const lockColumns = database
        .prepare("PRAGMA table_info(write_lock)")
        .all() as Array<{ name: string }>;
      if (!lockColumns.some((column) => column.name === "acquired_at")) {
        database.exec(
          "ALTER TABLE write_lock ADD COLUMN acquired_at INTEGER NOT NULL DEFAULT 0",
        );
      }
      return {
        database,
        select: database.prepare(SELECT_ROW),
        upsert: database.prepare(UPSERT_ROW),
        remove: database.prepare(DELETE_ROW),
        lockInsert: database.prepare(LOCK_INSERT),
        lockSelect: database.prepare(LOCK_SELECT),
        lockUpdate: database.prepare(LOCK_UPDATE),
        lockDelete: database.prepare(LOCK_DELETE),
        lockRelease: database.prepare(LOCK_RELEASE),
        rowsByPlugin: database.prepare(ROWS_BY_PLUGIN),
      };
    } catch (error) {
      throw new Error(
        `session-state: cannot open the state database at ${this.#path}`,
        { cause: error },
      );
    }
  }
}

const stores = new Map<string, SessionStore>();

// One store per resolved database path per process, so instances sharing a
// path share the in-process cache.
export function openStore(databasePath: string): SessionStore {
  const path = resolve(databasePath);
  const existing = stores.get(path);
  if (existing !== undefined) return existing;
  const store = new SessionStore(path);
  stores.set(path, store);
  return store;
}
