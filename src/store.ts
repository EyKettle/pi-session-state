import { mkdirSync } from "node:fs";
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

type ValueEntry = { kind: "value"; value: JsonValue };
type CacheEntry = ValueEntry | { kind: "absent" };

type OpenState = {
  database: DatabaseSync;
  select: StatementSync;
  upsert: StatementSync;
  remove: StatementSync;
};

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS state (
  plugin_id  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch_id  TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (plugin_id, session_id, branch_id)
)`;

const SELECT_ROW =
  "SELECT value FROM state WHERE plugin_id = ? AND session_id = ? AND branch_id = ?";
const UPSERT_ROW =
  "INSERT OR REPLACE INTO state (plugin_id, session_id, branch_id, value) VALUES (?, ?, ?, ?)";
const DELETE_ROW =
  "DELETE FROM state WHERE plugin_id = ? AND session_id = ? AND branch_id = ?";

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

function cacheKey(pluginId: string, sessionId: string, branchId: string): string {
  return `${pluginId}\u0000${sessionId}\u0000${branchId}`;
}

// store.ts -> key to row: SQLite reads and writes, an in-process cache, and
// the branch ascent. A branch read that misses the current key ascends run
// tops and, on its first hit, writes the value under the current key
// (materialization) before returning it. The tree view needed by the ascent
// arrives as an argument; this module reads no context, no Pi, and no clock.
export class SessionStore {
  readonly #path: string;
  #state: OpenState | undefined;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(databasePath: string) {
    this.#path = databasePath;
  }

  read(
    pluginId: string,
    sessionId: string,
    branchId: string,
    tree: SessionTreeView | null,
  ): JsonValue | undefined {
    const current = this.#load(pluginId, sessionId, branchId);
    if (current.kind === "value") return current.value;
    if (tree === null) return undefined;
    const inherited = this.#ascend(pluginId, sessionId, branchId, tree);
    if (inherited === undefined) return undefined;
    this.#storeValue(pluginId, sessionId, branchId, inherited.value);
    return inherited.value;
  }

  write(
    pluginId: string,
    sessionId: string,
    branchId: string,
    value: unknown,
  ): void {
    this.#storeValue(pluginId, sessionId, branchId, value);
  }

  drop(pluginId: string, sessionId: string, branchId: string): void {
    const { remove } = this.#ready();
    remove.run(pluginId, sessionId, branchId);
    this.#cache.delete(cacheKey(pluginId, sessionId, branchId));
  }

  // The scope's first load queries the disk; afterwards the cache answers.
  #load(pluginId: string, sessionId: string, branchId: string): CacheEntry {
    const key = cacheKey(pluginId, sessionId, branchId);
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;

    const { select } = this.#ready();
    const row = select.get(pluginId, sessionId, branchId) as
      | { value: string }
      | undefined;
    let entry: CacheEntry;
    if (row === undefined) {
      entry = { kind: "absent" };
    } else {
      let parsed: JsonValue;
      try {
        parsed = JSON.parse(row.value) as JsonValue;
      } catch (error) {
        throw new Error(
          `session-state: corrupt JSON stored for plugin ${pluginId} in session ${sessionId}`,
          { cause: error },
        );
      }
      entry = { kind: "value", value: parsed };
    }
    this.#cache.set(key, entry);
    return entry;
  }

  #ascend(
    pluginId: string,
    sessionId: string,
    startKey: string,
    tree: SessionTreeView,
  ): ValueEntry | undefined {
    let node = startKey;
    for (;;) {
      const parent = tree.parentOf(node);
      if (parent === null) return undefined;
      const parentKey = branchKeyFromLeaf(tree, parent);
      if (parentKey === null) return undefined;
      const entry = this.#load(pluginId, sessionId, parentKey);
      if (entry.kind === "value") return entry;
      node = parentKey;
    }
  }

  #storeValue(
    pluginId: string,
    sessionId: string,
    branchId: string,
    value: unknown,
  ): void {
    const json = serializeValue(value);
    const { upsert } = this.#ready();
    upsert.run(pluginId, sessionId, branchId, json);
    this.#cache.set(cacheKey(pluginId, sessionId, branchId), {
      kind: "value",
      value: value as JsonValue,
    });
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
      database.exec("PRAGMA journal_mode = WAL");
      database.exec(CREATE_TABLE);
      return {
        database,
        select: database.prepare(SELECT_ROW),
        upsert: database.prepare(UPSERT_ROW),
        remove: database.prepare(DELETE_ROW),
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
