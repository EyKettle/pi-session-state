import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import * as api from "../src/index.ts";
import { branchKey, openSessionState } from "../src/index.ts";
import { SessionWriteRefusedError } from "../src/store.ts";
import type { ExtensionContext } from "../deps/pi-coding-agent.ts";

type Node = { id: string; parentId: string | null };

const scratchDirs: string[] = [];
const envRestores: Array<() => void> = [];

function scratch(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "session-state-index-"));
  scratchDirs.push(dir);
  return { dir, path: join(dir, "states.sqlite") };
}

afterEach(() => {
  for (const restore of envRestores.splice(0)) restore();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function contextOf(
  sessionId: string,
  nodes: Node[],
  leafId: string | null,
): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => leafId,
      getEntries: () =>
        nodes.map((node) => ({ id: node.id, parentId: node.parentId })),
    },
  } as unknown as ExtensionContext;
}

function rawGet(path: string, sql: string, ...params: (string | number)[]) {
  const db = new DatabaseSync(path);
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

function seedLock(path: string, sessionId: string, holder: string): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare(
      "INSERT OR REPLACE INTO write_lock (session_id, holder) VALUES (?, ?)",
    ).run(sessionId, holder);
  } finally {
    db.close();
  }
}

describe("public surface", () => {
  it("exports exactly branchKey and openSessionState", () => {
    expect(Object.keys(api).sort()).toEqual(["branchKey", "openSessionState"]);
  });

  it("rejects invalid construction options", () => {
    const { path } = scratch();
    expect(() => openSessionState({ pluginId: "" })).toThrow();
    expect(() => openSessionState({ pluginId: "Bad_Id" })).toThrow();
    expect(() =>
      openSessionState({ pluginId: "ok", scope: "nope" as never }),
    ).toThrow();
    expect(() => openSessionState({ pluginId: "ok", databasePath: "" })).toThrow();
    expect(() =>
      openSessionState({ pluginId: "ok", databasePath: 42 as never }),
    ).toThrow();
    expect(() =>
      openSessionState({ pluginId: "role", databasePath: path }),
    ).not.toThrow();
  });

  it("stores and reads a session-scoped value through a context", () => {
    const { path } = scratch();
    const state = openSessionState<{ identity: string }>({
      pluginId: "role",
      databasePath: path,
    });
    const ctx = contextOf("s1", [{ id: "a", parentId: null }], "a");

    expect(state.read(ctx)).toBeUndefined();
    state.write(ctx, { identity: "planner" });
    expect(state.read(ctx)).toEqual({ identity: "planner" });
    state.drop(ctx);
    expect(state.read(ctx)).toBeUndefined();
  });

  it("follows the branch key derived from the context", () => {
    const { path } = scratch();
    const state = openSessionState<{ identity: string }>({
      pluginId: "role",
      scope: "branch",
      databasePath: path,
    });
    const nodes: Node[] = [
      { id: "r", parentId: null },
      { id: "x", parentId: "r" },
      { id: "y", parentId: "x" },
    ];
    const atY = contextOf("s1", nodes, "y");
    state.write(atY, { identity: "author" });

    nodes.push({ id: "z", parentId: "r" });
    const atZ = contextOf("s1", nodes, "z");
    expect(state.read(atZ)).toEqual({ identity: "author" });
    state.write(atZ, { identity: "reviewer" });
    expect(state.read(atZ)).toEqual({ identity: "reviewer" });
    expect(state.read(atY)).toEqual({ identity: "author" });
  });

  it("reports the current branch id through branchKey", () => {
    const nodes: Node[] = [
      { id: "r", parentId: null },
      { id: "x", parentId: "r" },
      { id: "y", parentId: "x" },
    ];
    expect(branchKey(contextOf("s1", nodes, "y"))).toBe("r");
    nodes.push({ id: "z", parentId: "r" });
    expect(branchKey(contextOf("s1", nodes, "z"))).toBe("z");
    expect(branchKey(contextOf("s1", nodes, null))).toBeNull();
  });

  it("returns isolated copies: caller mutation never changes later reads or the disk", () => {
    const { path } = scratch();
    const state = openSessionState<{ items: string[] }>({
      pluginId: "role",
      databasePath: path,
    });
    const ctx = contextOf("s1", [{ id: "a", parentId: null }], "a");

    const written = { items: ["x"] };
    state.write(ctx, written);
    written.items.push("y");

    const first = state.read(ctx);
    expect(first).toEqual({ items: ["x"] });
    first?.items.push("z");

    expect(state.read(ctx)).toEqual({ items: ["x"] });
    const disk = rawGet(
      path,
      "SELECT value FROM state WHERE plugin_id = ? AND session_id = ? AND branch_id = ?",
      "role",
      "s1",
      "",
    ) as { value: string };
    expect(disk.value).toBe(JSON.stringify({ items: ["x"] }));
  });

  it("holds a keyless branch write in memory and lands it once the context has a key", () => {
    const { path } = scratch();
    const state = openSessionState<{ identity: string }>({
      pluginId: "role",
      scope: "branch",
      databasePath: path,
    });
    // Open the database through a different session first.
    state.write(contextOf("s0", [{ id: "a", parentId: null }], "a"), {
      identity: "warm",
    });

    const empty = contextOf("s1", [], null);
    state.write(empty, { identity: "planner" });
    expect(state.read(empty)).toEqual({ identity: "planner" });
    expect(
      rawGet(
        path,
        "SELECT COUNT(*) AS n FROM state WHERE plugin_id = ? AND session_id = ?",
        "role",
        "s1",
      ),
    ).toEqual({ n: 0 });

    const keyed = contextOf("s1", [{ id: "a", parentId: null }], "a");
    expect(state.read(keyed)).toEqual({ identity: "planner" });
    const row = rawGet(
      path,
      "SELECT value FROM state WHERE plugin_id = ? AND session_id = ? AND branch_id = ?",
      "role",
      "s1",
      "a",
    ) as { value: string };
    expect(row.value).toBe(JSON.stringify({ identity: "planner" }));
  });

  it("refuses a concurrent same-session write and notifies through the UI when present", () => {
    const { path } = scratch();
    const state = openSessionState<{ v: number }>({
      pluginId: "role",
      databasePath: path,
    });
    // Open the database through a different session first.
    state.write(contextOf("seed", [{ id: "a", parentId: null }], "a"), { v: 0 });

    seedLock(path, "s1", "pid:1"); // a live holder (EPERM, not ESRCH)

    const notified: string[] = [];
    const uiCtx = {
      ...contextOf("s1", [{ id: "a", parentId: null }], "a"),
      hasUI: true,
      ui: {
        notify: (message: string) => {
          notified.push(message);
        },
      },
    } as unknown as ExtensionContext;
    expect(() => state.write(uiCtx, { v: 1 })).toThrow(SessionWriteRefusedError);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("pid:1");
    expect(notified[0]).toContain("reason:");

    const silentCtx = {
      ...contextOf("s1", [{ id: "a", parentId: null }], "a"),
      hasUI: false,
      ui: {
        notify: () => {
          throw new Error("must not notify when hasUI is false");
        },
      },
    } as unknown as ExtensionContext;
    let refusal: unknown;
    try {
      state.write(silentCtx, { v: 1 });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SessionWriteRefusedError);
  });

  it("resolves the default path under the agent directory override", () => {
    const { dir } = scratch();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    envRestores.push(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    });

    const state = openSessionState<{ v: number }>({ pluginId: "role" });
    state.write(contextOf("s1", [{ id: "a", parentId: null }], "a"), { v: 1 });

    expect(existsSync(join(dir, "sessions", "states.sqlite"))).toBe(true);
  });
});
