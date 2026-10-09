import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { branchKeyFromLeaf, type SessionTreeView } from "../src/branch.ts";
import {
  openStore,
  SessionWriteRefusedError,
  type StateKey,
} from "../src/store.ts";

type Node = { id: string; parentId: string | null };

function treeOf(nodes: Node[]): SessionTreeView {
  return {
    parentOf: (id) => nodes.find((node) => node.id === id)?.parentId ?? null,
    childrenOf: (id) =>
      nodes.filter((node) => node.parentId === id).map((node) => node.id),
  };
}

const scratchDirs: string[] = [];

function scratch(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "session-state-test-"));
  scratchDirs.push(dir);
  return { dir, path: join(dir, "states.sqlite") };
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function keyOf(
  pluginId: string,
  sessionId: string,
  branchId: string | null = "",
): StateKey {
  return { pluginId, sessionId, branchId };
}

function rawGet(path: string, sql: string, ...params: (string | number)[]) {
  const db = new DatabaseSync(path);
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

function rawRun(path: string, sql: string, ...params: (string | number)[]) {
  const db = new DatabaseSync(path);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function valueAt(
  path: string,
  pluginId: string,
  sessionId: string,
  branchId: string,
): string | undefined {
  const row = rawGet(
    path,
    "SELECT value FROM state WHERE plugin_id = ? AND session_id = ? AND branch_id = ?",
    pluginId,
    sessionId,
    branchId,
  ) as { value: string } | undefined;
  return row?.value;
}

function sessionRowCount(path: string, pluginId: string, sessionId: string): number {
  const row = rawGet(
    path,
    "SELECT COUNT(*) AS n FROM state WHERE plugin_id = ? AND session_id = ?",
    pluginId,
    sessionId,
  ) as { n: number };
  return row.n;
}

function lockHolder(path: string, sessionId: string): string | undefined {
  const row = rawGet(
    path,
    "SELECT holder FROM write_lock WHERE session_id = ?",
    sessionId,
  ) as { holder: string } | undefined;
  return row?.holder;
}

const CHILD_HOLDS_WRITE_LOCK = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.CHILD_DB);
db.exec("BEGIN IMMEDIATE");
console.log("LOCKED");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, 400);
`;

describe("session store", () => {
  it("opens with WAL enabled and the state and write_lock tables", () => {
    const { path } = scratch();
    const store = openStore(path);
    store.write(keyOf("p", "s"), 1);

    const db = new DatabaseSync(path);
    try {
      const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(mode.journal_mode).toBe("wal");
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toContain("state");
      expect(tables).toContain("write_lock");
    } finally {
      db.close();
    }
  });

  it("round-trips values and distinguishes absence from a stored null", () => {
    const { path } = scratch();
    const store = openStore(path);
    const key = keyOf("p", "s");

    expect(store.read(key, null)).toBeUndefined();
    store.write(key, null);
    expect(store.read(key, null)).toBeNull();
    store.write(key, { nested: [1, "two", null], flag: true });
    expect(store.read(key, null)).toEqual({
      nested: [1, "two", null],
      flag: true,
    });
  });

  it("throws when writing undefined", () => {
    const { path } = scratch();
    const store = openStore(path);
    expect(() => store.write(keyOf("p", "s"), undefined)).toThrow();
  });

  it("throws when the value does not survive JSON serialization", () => {
    const { path } = scratch();
    const store = openStore(path);
    expect(() => store.write(keyOf("p", "s"), () => 1)).toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => store.write(keyOf("p", "s"), circular)).toThrow();
  });

  it("leaves exactly one row after repeated writes on one branch", () => {
    const { path } = scratch();
    const store = openStore(path);
    store.write(keyOf("p", "s", "b1"), "first");
    store.write(keyOf("p", "s", "b1"), "second");
    expect(
      (rawGet(
        path,
        "SELECT COUNT(*) AS n FROM state WHERE plugin_id = ? AND session_id = ? AND branch_id = ?",
        "p",
        "s",
        "b1",
      ) as { n: number }).n,
    ).toBe(1);
    expect(store.read(keyOf("p", "s", "b1"), null)).toBe("second");
  });

  it("never ascends on the session scope", () => {
    const { path } = scratch();
    const store = openStore(path);
    store.write(keyOf("p", "s", "branch-key"), "branch value");
    expect(store.read(keyOf("p", "s"), null)).toBeUndefined();
    store.write(keyOf("p", "s"), "session value");
    expect(store.read(keyOf("p", "s"), null)).toBe("session value");
  });

  it("a branch forked above a leaf reads the value visible at the fork, materialized under its key", () => {
    const { path } = scratch();
    const nodes: Node[] = [
      { id: "r", parentId: null },
      { id: "x", parentId: "r" },
      { id: "y", parentId: "x" },
    ];
    const view = treeOf(nodes);
    const store = openStore(path);

    const beforeFork = branchKeyFromLeaf(view, "y");
    expect(beforeFork).toBe("r");
    store.write(keyOf("p", "s", beforeFork), "V1");

    nodes.push({ id: "z", parentId: "r" });
    const forkKey = branchKeyFromLeaf(view, "z");
    expect(forkKey).toBe("z");

    expect(store.read(keyOf("p", "s", forkKey), view)).toBe("V1");
    expect(valueAt(path, "p", "s", "z")).toBe(JSON.stringify("V1"));
  });

  it("a write on one branch leaves the sibling rows and reads unchanged", () => {
    const { path } = scratch();
    const nodes: Node[] = [
      { id: "r", parentId: null },
      { id: "x", parentId: "r" },
      { id: "y", parentId: "x" },
    ];
    const view = treeOf(nodes);
    const store = openStore(path);

    store.write(keyOf("p", "s", branchKeyFromLeaf(view, "y")), "V1");
    nodes.push({ id: "z", parentId: "r" });
    const forkKey = branchKeyFromLeaf(view, "z");
    const oldBranchKey = branchKeyFromLeaf(view, "y");
    expect(oldBranchKey).toBe("x");
    expect(store.read(keyOf("p", "s", forkKey), view)).toBe("V1");
    expect(store.read(keyOf("p", "s", oldBranchKey), view)).toBe("V1");

    store.write(keyOf("p", "s", forkKey), "V2");
    expect(store.read(keyOf("p", "s", forkKey), view)).toBe("V2");
    expect(store.read(keyOf("p", "s", oldBranchKey), view)).toBe("V1");
    expect(valueAt(path, "p", "s", "r")).toBe(JSON.stringify("V1"));
    expect(valueAt(path, "p", "s", "x")).toBe(JSON.stringify("V1"));
  });

  it("serves a loaded scope from the in-process cache (out-of-band writes stay invisible)", () => {
    const { path } = scratch();
    const store = openStore(path);
    store.write(keyOf("p", "s"), "v1");
    expect(store.read(keyOf("p", "s"), null)).toBe("v1");

    rawRun(
      path,
      "UPDATE state SET value = ? WHERE plugin_id = ? AND session_id = ? AND branch_id = ?",
      JSON.stringify("v2"),
      "p",
      "s",
      "",
    );

    expect(valueAt(path, "p", "s", "")).toBe(JSON.stringify("v2"));
    expect(store.read(keyOf("p", "s"), null)).toBe("v1");
  });

  it("drop removes the value of the scope", () => {
    const { path } = scratch();
    const store = openStore(path);
    store.write(keyOf("p", "s"), "value");
    store.drop(keyOf("p", "s"));
    expect(store.read(keyOf("p", "s"), null)).toBeUndefined();
    store.drop(keyOf("p", "s"));
  });

  it("an unusable database produces a throw and not undefined", () => {
    const { dir } = scratch();
    const store = openStore(dir);
    expect(() => store.read(keyOf("p", "s"), null)).toThrow();
    expect(() => store.write(keyOf("p", "s"), 1)).toThrow();
  });

  it("returns a fresh copy on every read, so caller mutation cannot fork read from disk", () => {
    const { path } = scratch();
    const store = openStore(path);
    const key = keyOf("p", "s", "b");

    const written = { items: ["x"] };
    store.write(key, written);
    written.items.push("y");

    const first = store.read(key, null) as { items: string[] };
    expect(first).toEqual({ items: ["x"] });
    first.items.push("z");

    expect(store.read(key, null)).toEqual({ items: ["x"] });
    expect(valueAt(path, "p", "s", "b")).toBe(JSON.stringify({ items: ["x"] }));
  });

  it("holds a keyless write in memory until a key exists, then lands it on disk", () => {
    const { path } = scratch();
    const store = openStore(path);
    const keyless = keyOf("p", "s", null);
    store.read(keyOf("p", "warm"), null); // open the database first

    store.write(keyless, { identity: "planner" });
    expect(store.read(keyless, null)).toEqual({ identity: "planner" });
    expect(sessionRowCount(path, "p", "s")).toBe(0);

    expect(store.read(keyOf("p", "s", "k1"), null)).toEqual({ identity: "planner" });
    expect(valueAt(path, "p", "s", "k1")).toBe(JSON.stringify({ identity: "planner" }));
  });

  it("a keyed write supersedes a keyless one, and a keyless drop clears it", () => {
    const { path } = scratch();
    const store = openStore(path);

    store.write(keyOf("p", "s1", null), "pending");
    store.write(keyOf("p", "s1", "k"), "landed");
    expect(store.read(keyOf("p", "s1", "k"), null)).toBe("landed");
    expect(valueAt(path, "p", "s1", "k")).toBe(JSON.stringify("landed"));

    store.write(keyOf("p", "s2", null), "pending");
    store.drop(keyOf("p", "s2", null));
    expect(store.read(keyOf("p", "s2", null), null)).toBeUndefined();
    expect(sessionRowCount(path, "p", "s2")).toBe(0);
  });

  it("refuses a concurrent same-session write with the four elements, and reads still proceed", () => {
    const { path } = scratch();
    const store = openStore(path);
    store.read(keyOf("p", "seed"), null); // opens the database and its schema

    // A live lock holder: pid 1 exists (kill reports EPERM, not ESRCH).
    rawRun(path, "INSERT INTO write_lock (session_id, holder, acquired_at) VALUES (?, ?, ?)", "s1", "pid:1", Date.now());

    let refusal: unknown;
    try {
      store.write(keyOf("p", "s1"), 1);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SessionWriteRefusedError);
    const message = (refusal as Error).message;
    expect(message).toContain("pid:1");
    expect(message).toContain("write");
    expect(message).toContain("s1");
    expect(message).toContain("reason:");

    // A different session is not blocked.
    store.write(keyOf("p", "s2"), 2);
    // Reads proceed while the session lock is held.
    expect(store.read(keyOf("p", "s1"), null)).toBeUndefined();
  });

  it("takes over a lock left by a dead process and releases the lock after every write", () => {
    const { path } = scratch();
    const store = openStore(path);
    store.read(keyOf("p", "seed"), null);

    rawRun(path, "INSERT INTO write_lock (session_id, holder, acquired_at) VALUES (?, ?, ?)", "s1", "pid:999999", Date.now());
    store.write(keyOf("p", "s1"), 1);
    expect(lockHolder(path, "s1")).toBeUndefined();

    store.write(keyOf("p", "s1"), 2);
    expect(lockHolder(path, "s1")).toBeUndefined();
  });

  it("waits for cross-session contention instead of failing while another connection holds the write lock", async () => {
    const { path } = scratch();
    const store = openStore(path);
    store.write(keyOf("p", "warm"), 0);

    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", CHILD_HOLDS_WRITE_LOCK],
      { env: { ...process.env, CHILD_DB: path }, stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("LOCKED")) resolve();
      });
      child.on("error", reject);
    });

    const started = Date.now();
    store.write(keyOf("p", "other"), 1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);

    await new Promise<void>((resolve) => child.on("close", () => resolve()));
  }, 10000);

  it("takes over an aged lock row even when its pid is alive", () => {
    const { path } = scratch();
    const store = openStore(path);
    store.read(keyOf("p", "seed"), null);

    rawRun(
      path,
      "INSERT INTO write_lock (session_id, holder, acquired_at) VALUES (?, ?, ?)",
      "s1",
      "pid:1",
      Date.now() - 61_000,
    );
    store.write(keyOf("p", "s1"), 1);
    expect(lockHolder(path, "s1")).toBeUndefined();
  });

  it("upgrades a database whose write_lock predates the lease column", () => {
    const { path } = scratch();
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(
        "CREATE TABLE write_lock (session_id TEXT PRIMARY KEY, holder TEXT NOT NULL)",
      );
      legacy
        .prepare("INSERT INTO write_lock (session_id, holder) VALUES (?, ?)")
        .run("s1", "pid:1");
    } finally {
      legacy.close();
    }

    const store = openStore(path);
    store.write(keyOf("p", "s1"), 1);
    expect(lockHolder(path, "s1")).toBeUndefined();
    const column = rawGet(
      path,
      "SELECT name FROM pragma_table_info('write_lock') WHERE name = ?",
      "acquired_at",
    ) as { name: string } | undefined;
    expect(column?.name).toBe("acquired_at");
  });
});
