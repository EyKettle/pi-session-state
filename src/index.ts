import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { branchKeyFromLeaf, type SessionTreeView } from "./branch.ts";
import { getAgentDir, type ExtensionContext } from "../deps/pi-coding-agent.ts";
import { readSettingsText, resolveConfiguredLocation } from "./settings.ts";
import { openStore, SessionWriteRefusedError, type StateKey } from "./store.ts";

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
    (typeof databasePath !== "string" ||
      databasePath.length === 0 ||
      !isAbsolute(databasePath))
  ) {
    throw new TypeError(
      "session-state: databasePath must be a non-empty absolute path when provided",
    );
  }
  return { pluginId, scope, databasePath };
}

// The three sources, first hit wins: the integration parameter, the
// agent-level settings file, the default location.
function resolveDatabasePath(databasePath: string | undefined): string {
  if (databasePath !== undefined) return databasePath;
  const agentDir = getAgentDir();
  const configured = resolveConfiguredLocation({
    text: readSettingsText(agentDir),
    agentDir,
    homeDir: homedir(),
  });
  if (configured.kind === "absolute") return configured.path;
  return join(agentDir, "sessions", "states.sqlite");
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

// One expression of how a context yields a branch key and its tree.
function branchKeyContext(ctx: ExtensionContext): {
  branchId: string | null;
  tree: SessionTreeView;
} {
  const manager = ctx.sessionManager;
  const tree = sessionView(manager);
  return {
    branchId: branchKeyFromLeaf(tree, manager.getLeafId()),
    tree,
  };
}

export function openSessionState<T>(
  options: SessionStateOptions,
): SessionState<T> {
  const { pluginId, scope, databasePath } = validateOptions(options);
  const store = openStore(resolveDatabasePath(databasePath));

  // The scope's key derivation is fixed at construction.
  const resolveContext: (
    ctx: ExtensionContext,
  ) => { key: StateKey; tree: SessionTreeView | null } =
    scope === "session"
      ? (ctx) => ({
          key: {
            pluginId,
            sessionId: ctx.sessionManager.getSessionId(),
            branchId: "",
          },
          tree: null,
        })
      : (ctx) => {
          const { branchId, tree } = branchKeyContext(ctx);
          return {
            key: {
              pluginId,
              sessionId: ctx.sessionManager.getSessionId(),
              branchId,
            },
            tree,
          };
        };

  const notifyRefusal = (ctx: ExtensionContext, error: unknown): void => {
    if (error instanceof SessionWriteRefusedError && ctx.hasUI) {
      ctx.ui.notify(error.message, "error");
    }
  };

  return {
    read(ctx: ExtensionContext): T | undefined {
      const { key, tree } = resolveContext(ctx);
      return store.read(key, tree) as T | undefined;
    },

    write(ctx: ExtensionContext, value: T): void {
      const { key } = resolveContext(ctx);
      try {
        store.write(key, value);
      } catch (error) {
        notifyRefusal(ctx, error);
        throw error;
      }
    },

    drop(ctx: ExtensionContext): void {
      const { key } = resolveContext(ctx);
      try {
        store.drop(key);
      } catch (error) {
        notifyRefusal(ctx, error);
        throw error;
      }
    },
  };
}

export function branchKey(ctx: ExtensionContext): string | null {
  return branchKeyContext(ctx).branchId;
}
