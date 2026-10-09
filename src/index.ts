import { join } from "node:path";
import { branchKeyFromLeaf, type SessionTreeView } from "./branch.ts";
import { getAgentDir, type ExtensionContext } from "../deps/pi-coding-agent.ts";
import { openStore } from "./store.ts";

export type SessionStateScope = "session" | "branch";

export interface SessionStateOptions {
  pluginId: string;
  scope?: SessionStateScope;
  databasePath?: string;
}

export interface SessionState<T> {
  read(ctx: ExtensionContext): T | undefined;
  write(ctx: ExtensionContext, value: T): void;
  drop(ctx: ExtensionContext): void;
}

const PLUGIN_ID_PATTERN = /^[a-z0-9.-]+$/;

function validateOptions(options: SessionStateOptions): {
  pluginId: string;
  scope: SessionStateScope;
  databasePath: string | undefined;
} {
  const { pluginId, scope = "session", databasePath } = options;
  if (typeof pluginId !== "string" || !PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new TypeError(
      "session-state: pluginId must be non-empty and contain only lowercase letters, digits, hyphens, and dots",
    );
  }
  if (scope !== "session" && scope !== "branch") {
    throw new TypeError(
      `session-state: scope must be "session" or "branch", got ${JSON.stringify(scope)}`,
    );
  }
  if (
    databasePath !== undefined &&
    (typeof databasePath !== "string" || databasePath.length === 0)
  ) {
    throw new TypeError(
      "session-state: databasePath must be a non-empty string when provided",
    );
  }
  return { pluginId, scope, databasePath };
}

// The session tree arrives as a structural view, rebuilt on every call so
// nothing is held across contexts.
function sessionView(manager: ExtensionContext["sessionManager"]): SessionTreeView {
  const entries = manager.getEntries();
  const parents = new Map<string, string | null>();
  const children = new Map<string, string[]>();
  for (const entry of entries) {
    parents.set(entry.id, entry.parentId);
    if (entry.parentId !== null) {
      const list = children.get(entry.parentId);
      if (list === undefined) children.set(entry.parentId, [entry.id]);
      else list.push(entry.id);
    }
  }
  return {
    parentOf: (id) => parents.get(id) ?? null,
    childrenOf: (id) => children.get(id) ?? [],
  };
}

function branchKeyOf(ctx: ExtensionContext): string | null {
  const manager = ctx.sessionManager;
  return branchKeyFromLeaf(sessionView(manager), manager.getLeafId());
}

export function openSessionState<T>(
  options: SessionStateOptions,
): SessionState<T> {
  const { pluginId, scope, databasePath } = validateOptions(options);
  const store = openStore(
    databasePath ?? join(getAgentDir(), "sessions", "states.sqlite"),
  );

  return {
    read(ctx: ExtensionContext): T | undefined {
      const manager = ctx.sessionManager;
      const sessionId = manager.getSessionId();
      if (scope === "session") {
        return store.read(pluginId, sessionId, "", null) as T | undefined;
      }
      const view = sessionView(manager);
      const key = branchKeyFromLeaf(view, manager.getLeafId());
      if (key === null) return undefined;
      return store.read(pluginId, sessionId, key, view) as T | undefined;
    },

    write(ctx: ExtensionContext, value: T): void {
      const sessionId = ctx.sessionManager.getSessionId();
      if (scope === "session") {
        store.write(pluginId, sessionId, "", value);
        return;
      }
      const key = branchKeyOf(ctx);
      if (key === null) {
        // A keyless branch write would land on the session row; fail instead.
        throw new Error(
          "session-state: the context has no branch key; nothing to write to",
        );
      }
      store.write(pluginId, sessionId, key, value);
    },

    drop(ctx: ExtensionContext): void {
      const sessionId = ctx.sessionManager.getSessionId();
      if (scope === "session") {
        store.drop(pluginId, sessionId, "");
        return;
      }
      const key = branchKeyOf(ctx);
      if (key === null) return;
      store.drop(pluginId, sessionId, key);
    },
  };
}

export function branchKey(ctx: ExtensionContext): string | null {
  return branchKeyOf(ctx);
}
