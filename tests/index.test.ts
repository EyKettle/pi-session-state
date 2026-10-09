import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as api from "../src/index.ts";
import { branchKey, openSessionState } from "../src/index.ts";
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

    nodes.push({ id: "z", parentId: "r" }); // a fork above the leaf
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

  it("treats a context without a branch key as an absent branch scope", () => {
    const { path } = scratch();
    const state = openSessionState<string>({
      pluginId: "role",
      scope: "branch",
      databasePath: path,
    });
    const ctx = contextOf("s1", [], null);
    expect(state.read(ctx)).toBeUndefined();
    expect(() => state.write(ctx, "value")).toThrow();
    expect(() => state.drop(ctx)).not.toThrow();
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
