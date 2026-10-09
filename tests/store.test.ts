import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { branchKeyFromLeaf, type SessionTreeView } from "../src/branch.ts";
import { openStore } from "../src/store.ts";

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

function valueAt(
  path: string,
  pluginId: string,
  sessionId: string,
  branchId: string,
): string | undefined {
  const db = new DatabaseSync(path);
  try {
    const row = db
      .prepare(
        "SELECT value FROM state WHERE plugin_id = ? AND session_id = ? AND branch_id = ?",
      )
      .get(pluginId, sessionId, branchId) as { value: string } | undefined;
    return row?.value;
  } finally {
    db.close();
  }
}

function rowCountAt(
  path: string,
  pluginId: string,
  sessionId: string,
  branchId: string,
): number {
  const db = new DatabaseSync(path);
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM state WHERE plugin_id = ? AND session_id = ? AND branch_id = ?",
      )
      .get(pluginId, sessionId, branchId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

describe("session store", () => {
  it("opens with WAL enabled and the four-column state table", () => {
    const { path } = scratch();
    const store = openStore(path);
    store.write("p", "s", "", 1);

    const db = new DatabaseSync(path);
    try {
      const mode = db.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      expect(mode.journal_mode).toBe("wal");
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state'")
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("state");
    } finally {
      db.close();
    }
  });

  it("round-trips values and distinguishes absence from a stored null", () => {
    const { path } = scratch();
    const store = openStore(path);

    expect(store.read("p", "s", "", null)).toBeUndefined();
    store.write("p", "s", "", null);
    expect(store.read("p", "s", "", null)).toBeNull();
    store.write("p", "s", "", { nested: [1, "two", null], flag: true });
    expect(store.read("p", "s", "", null)).toEqual({
      nested: [1, "two", null],
      flag: true,
    });
  });

  it("throws when writing undefined", () => {
    const { path } = scratch();
    const store = openStore(path);
    expect(() => store.write("p", "s", "", undefined)).toThrow();
  });

  it("throws when the value does not survive JSON serialization", () => {
    const { path } = scratch();
    const store = openStore(path);
    expect(() => store.write("p", "s", "", () => 1)).toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => store.write("p", "s", "", circular)).toThrow();
  });

  it("leaves exactly one row after repeated writes on one branch", () => {
    const { path } = scratch();
    const store = openStore(path);
    store.write("p", "s", "b1", "first");
    store.write("p", "s", "b1", "second");
    expect(rowCountAt(path, "p", "s", "b1")).toBe(1);
    expect(store.read("p", "s", "b1", null)).toBe("second");
  });

  it("never ascends on the session scope", () => {
    const { path } = scratch();
    const store = openStore(path);
    store.write("p", "s", "branch-key", "branch value");
    expect(store.read("p", "s", "", null)).toBeUndefined();
    store.write("p", "s", "", "session value");
    expect(store.read("p", "s", "", null)).toBe("session value");
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
    store.write("p", "s", beforeFork!, "V1");

    nodes.push({ id: "z", parentId: "r" }); // new fork above the leaf
    const forkKey = branchKeyFromLeaf(view, "z");
    expect(forkKey).toBe("z");

    expect(store.read("p", "s", forkKey!, view)).toBe("V1");
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

    store.write("p", "s", branchKeyFromLeaf(view, "y")!, "V1");
    nodes.push({ id: "z", parentId: "r" });
    const forkKey = branchKeyFromLeaf(view, "z")!;
    const oldBranchKey = branchKeyFromLeaf(view, "y")!;
    expect(oldBranchKey).toBe("x");
    expect(store.read("p", "s", forkKey, view)).toBe("V1"); // z inherits at the fork
    expect(store.read("p", "s", oldBranchKey, view)).toBe("V1"); // the old branch keeps its value

    store.write("p", "s", forkKey, "V2");
    expect(store.read("p", "s", forkKey, view)).toBe("V2");
    expect(store.read("p", "s", oldBranchKey, view)).toBe("V1");
    expect(valueAt(path, "p", "s", "r")).toBe(JSON.stringify("V1"));
    expect(valueAt(path, "p", "s", "x")).toBe(JSON.stringify("V1"));
  });

  it("serves a loaded scope from the in-process cache (out-of-band writes stay invisible)", () => {
    const { path } = scratch();
    const store = openStore(path);
    store.write("p", "s", "", "v1");
    expect(store.read("p", "s", "", null)).toBe("v1");

    const other = new DatabaseSync(path);
    other
      .prepare(
        "UPDATE state SET value = ? WHERE plugin_id = ? AND session_id = ? AND branch_id = ?",
      )
      .run(JSON.stringify("v2"), "p", "s", "");
    other.close();

    expect(valueAt(path, "p", "s", "")).toBe(JSON.stringify("v2"));
    expect(store.read("p", "s", "", null)).toBe("v1");
  });

  it("drop removes the value of the scope", () => {
    const { path } = scratch();
    const store = openStore(path);
    store.write("p", "s", "", "value");
    store.drop("p", "s", "");
    expect(store.read("p", "s", "", null)).toBeUndefined();
    store.drop("p", "s", ""); // dropping an absent scope is a no-op
  });

  it("an unusable database produces a throw and not undefined", () => {
    const { dir } = scratch();
    const store = openStore(dir); // a directory cannot be opened as a database
    expect(() => store.read("p", "s", "", null)).toThrow();
    expect(() => store.write("p", "s", "", 1)).toThrow();
  });
});
