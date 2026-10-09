import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  confirmResult = true,
  confirmCalls: string[] = [],
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
      confirm: async (title: string, message: string) => {
        confirmCalls.push(`${title} :: ${message}`);
        return confirmResult;
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

function lockHolderAt(path: string, sessionId: string): string | undefined {
  const db = new DatabaseSync(path);
  try {
    const row = db
      .prepare("SELECT holder FROM write_lock WHERE session_id = ?")
      .get(sessionId) as { holder: string } | undefined;
    return row?.holder;
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

  it("registers /state:force-refresh", () => {
    const { commands } = loadExtension();
    expect(commands.has("state:force-refresh")).toBe(true);
  });

  it("/state:force-refresh clears the lock row and this process's cache, leaving state rows", async () => {
    const dir = scratch();
    withAgentDir(dir);
    const { commands } = loadExtension();
    const path = join(dir, "sessions", "states.sqlite");
    const store = openStore(path);
    const key = { pluginId: "role", sessionId: "s1", branchId: "" };
    store.write(key, "v1");
    expect(store.read(key, null)).toBe("v1");

    const other = new DatabaseSync(path);
    try {
      other
        .prepare(
          "UPDATE state SET value = ? WHERE plugin_id = ? AND session_id = ? AND branch_id = ?",
        )
        .run(JSON.stringify("v2"), "role", "s1", "");
    } finally {
      other.close();
    }
    expect(store.read(key, null)).toBe("v1");

    seedLock(path, "s1", "pid:999999");

    const messages: string[] = [];
    await commands.get("state:force-refresh")?.handler("", contextFor("s1", true, messages));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("next read comes from disk");

    const db = new DatabaseSync(path);
    try {
      expect(
        (db
          .prepare("SELECT COUNT(*) AS n FROM write_lock WHERE session_id = ?")
          .get("s1") as { n: number }).n,
      ).toBe(0);
      expect(
        (db
          .prepare("SELECT COUNT(*) AS n FROM state WHERE session_id = ?")
          .get("s1") as { n: number }).n,
      ).toBe(1);
    } finally {
      db.close();
    }
    expect(store.read(key, null)).toBe("v2");
  });

  it("/state:force-refresh asks before clearing a live holder's lock", async () => {
    const dir = scratch();
    withAgentDir(dir);
    const { commands } = loadExtension();
    const path = join(dir, "sessions", "states.sqlite");
    const store = openStore(path);
    store.write({ pluginId: "role", sessionId: "s1", branchId: "" }, "v");
    seedLock(path, "s1", "pid:1");

    const keptMessages: string[] = [];
    const keptCalls: string[] = [];
    await commands
      .get("state:force-refresh")
      ?.handler("", contextFor("s1", true, keptMessages, false, keptCalls));
    expect(keptCalls).toHaveLength(1);
    expect(lockHolderAt(path, "s1")).toBe("pid:1");

    const clearedMessages: string[] = [];
    const clearedCalls: string[] = [];
    await commands
      .get("state:force-refresh")
      ?.handler("", contextFor("s1", true, clearedMessages, true, clearedCalls));
    expect(clearedCalls).toHaveLength(1);
    expect(lockHolderAt(path, "s1")).toBeUndefined();
  });

  it("/state:force-refresh does not clear a live holder without a UI to confirm", async () => {
    const dir = scratch();
    withAgentDir(dir);
    const { commands } = loadExtension();
    const path = join(dir, "sessions", "states.sqlite");
    const store = openStore(path);
    store.write({ pluginId: "role", sessionId: "s1", branchId: "" }, "v");
    seedLock(path, "s1", "pid:1");

    const messages: string[] = [];
    await commands.get("state:force-refresh")?.handler("", contextFor("s1", false, messages));
    expect(messages).toHaveLength(0);
    expect(lockHolderAt(path, "s1")).toBe("pid:1");
  });

  it("reports an unusable configured location at session_start", async () => {
    const dir = scratch();
    withAgentDir(dir);
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ sessionState: { databasePath: 42 } }),
    );
    const { events } = loadExtension();

    const messages: string[] = [];
    await events.get("session_start")?.({}, contextFor("s1", true, messages));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("sessionState.databasePath");
    expect(messages[0]).toContain(join(dir, "sessions", "states.sqlite"));
  });

  it("stays silent for a usable or absent configured location", async () => {
    const dir = scratch();
    withAgentDir(dir);
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ sessionState: { databasePath: join(dir, "custom.sqlite") } }),
    );
    const usable = loadExtension();
    const usableMessages: string[] = [];
    await usable.events.get("session_start")?.({}, contextFor("s1", true, usableMessages));
    expect(usableMessages).toHaveLength(0);

    rmSync(join(dir, "settings.json"));
    const absent = loadExtension();
    const absentMessages: string[] = [];
    await absent.events.get("session_start")?.({}, contextFor("s1", true, absentMessages));
    expect(absentMessages).toHaveLength(0);
  });

  it("stays silent without a UI even for an unusable location", async () => {
    const dir = scratch();
    withAgentDir(dir);
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ sessionState: { databasePath: 42 } }),
    );
    const { events } = loadExtension();

    const messages: string[] = [];
    await events.get("session_start")?.({}, contextFor("s1", false, messages));
    expect(messages).toHaveLength(0);
  });

  it("reports a settings file that is not valid JSON at session_start", async () => {
    const dir = scratch();
    withAgentDir(dir);
    writeFileSync(join(dir, "settings.json"), "not json");
    const { events } = loadExtension();

    const messages: string[] = [];
    await events.get("session_start")?.({}, contextFor("s1", true, messages));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("not valid JSON");
  });

  it("reports a ~user configured location at session_start", async () => {
    const dir = scratch();
    withAgentDir(dir);
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ sessionState: { databasePath: "~other/db.sqlite" } }),
    );
    const { events } = loadExtension();

    const messages: string[] = [];
    await events.get("session_start")?.({}, contextFor("s1", true, messages));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("~user");
  });

  it("/state:status does not create the database", async () => {
    const dir = scratch();
    withAgentDir(dir);
    const { commands } = loadExtension();
    const path = join(dir, "sessions", "states.sqlite");

    const messages: string[] = [];
    await commands.get("state:status")?.handler("", contextFor("s1", true, messages));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("lock: none");
    expect(messages[0]).toContain("state rows: none");
    expect(existsSync(path)).toBe(false);
  });
});
