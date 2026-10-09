import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../src/extension.ts";
import { openStore } from "../src/store.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "../deps/pi-coding-agent.ts";

const scratchDirs: string[] = [];
const envRestores: Array<() => void> = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-state-extension-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const restore of envRestores.splice(0)) restore();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function withAgentDir(dir: string): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  envRestores.push(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
}

type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void>;

interface LoadedExtension {
  commands: Map<string, { description?: string; handler: CommandHandler }>;
  events: Map<string, (event: unknown, ctx: ExtensionCommandContext) => unknown>;
}

function loadExtension(): LoadedExtension {
  const commands = new Map<
    string,
    { description?: string; handler: CommandHandler }
  >();
  const events = new Map<
    string,
    (event: unknown, ctx: ExtensionCommandContext) => unknown
  >();
  const pi = {
    registerCommand: (
      name: string,
      options: { description?: string; handler: CommandHandler },
    ) => {
      commands.set(name, options);
    },
    on: (
      event: string,
      handler: (event: unknown, ctx: ExtensionCommandContext) => unknown,
    ) => {
      events.set(event, handler);
      return () => {};
    },
  } as unknown as ExtensionAPI;
  extension(pi);
  return { commands, events };
}

function contextFor(
  sessionId: string,
  hasUI: boolean,
  messages: string[],
): ExtensionCommandContext {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => null,
      getEntries: () => [],
    },
    hasUI,
    ui: {
      notify: (message: string) => {
        messages.push(message);
      },
    },
  } as unknown as ExtensionCommandContext;
}

function seedLock(path: string, sessionId: string, holder: string): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare(
      "INSERT OR REPLACE INTO write_lock (session_id, holder, acquired_at) VALUES (?, ?, ?)",
    ).run(sessionId, holder, Date.now());
  } finally {
    db.close();
  }
}

describe("extension entry", () => {
  it("registers /state:status", () => {
    const { commands } = loadExtension();
    expect(commands.has("state:status")).toBe(true);
  });

  it("/state:status reports the database path, the lock row, and per-plugin rows", async () => {
    const dir = scratch();
    withAgentDir(dir);
    const { commands } = loadExtension();
    const path = join(dir, "sessions", "states.sqlite");
    const store = openStore(path);
    store.write({ pluginId: "role", sessionId: "s1", branchId: "" }, "a");
    store.write({ pluginId: "skill-tools", sessionId: "s1", branchId: "k" }, "b");
    seedLock(path, "s1", "pid:1");

    const messages: string[] = [];
    await commands.get("state:status")?.handler("", contextFor("s1", true, messages));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`database: ${path}`);
    expect(messages[0]).toContain("lock: pid:1 (alive)");
    expect(messages[0]).toContain("role: 1");
    expect(messages[0]).toContain("skill-tools: 1");

    const empty: string[] = [];
    await commands.get("state:status")?.handler("", contextFor("s2", true, empty));
    expect(empty).toHaveLength(1);
    expect(empty[0]).toContain("lock: none");
    expect(empty[0]).toContain("state rows: none");
  });

  it("stays silent without a UI", async () => {
    const dir = scratch();
    withAgentDir(dir);
    const { commands } = loadExtension();
    const messages: string[] = [];
    await commands.get("state:status")?.handler("", contextFor("s1", false, messages));
    expect(messages).toHaveLength(0);
  });
});
