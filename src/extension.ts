import { homedir } from "node:os";
import { getAgentDir } from "../deps/pi-coding-agent.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "../deps/pi-coding-agent.ts";
import { resolveAgentDatabasePath } from "./settings.ts";
import { holderIsAlive, openStore, type SessionStore } from "./store.ts";

function statusLines(
  databasePath: string,
  sessionId: string,
  store: SessionStore,
): string[] {
  const report = store.inspectSession(sessionId);
  const lock =
    report.lock === undefined
      ? "lock: none"
      : `lock: ${report.lock.holder} (${
          holderIsAlive(report.lock.holder) ? "alive" : "not alive"
        })`;
  const rows =
    report.rowsByPlugin.length === 0
      ? "state rows: none"
      : `state rows: ${report.rowsByPlugin
          .map((entry) => `${entry.pluginId}: ${entry.count}`)
          .join(", ")}`;
  return ["session-state /state:status", `database: ${databasePath}`, lock, rows];
}

// The Pi entry: package.json's pi.extensions points here. It starts no
// long-lived resource; the store opens lazily on first use.
export default function extension(pi: ExtensionAPI): void {
  const location = resolveAgentDatabasePath(getAgentDir(), homedir());
  const store = openStore(location.path);

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const fallback = `using the default location ${location.path}`;
    if (location.configured === "malformed") {
      ctx.ui.notify(
        `session-state: the settings file is not valid JSON; ${fallback}`,
        "warning",
      );
    } else if (location.configured === "invalid") {
      ctx.ui.notify(
        `session-state: the sessionState.databasePath setting is not a non-empty string; ${fallback}`,
        "warning",
      );
    } else if (location.configured === "unsupported") {
      ctx.ui.notify(
        `session-state: the sessionState.databasePath setting uses a "~user" form the contract cannot express; ${fallback}`,
        "warning",
      );
    }
  });

  pi.registerCommand("state:status", {
    description: "Report this session's lock row and state rows",
    handler: async (
      _args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      if (!ctx.hasUI) return;
      const lines = statusLines(
        location.path,
        ctx.sessionManager.getSessionId(),
        store,
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("state:force-refresh", {
    description: "Clear this session's lock row and this process's cache",
    handler: async (
      _args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      const sessionId = ctx.sessionManager.getSessionId();
      const lock = store.inspectSession(sessionId).lock;
      if (lock !== undefined && holderIsAlive(lock.holder)) {
        if (!ctx.hasUI) return;
        const confirmed = await ctx.ui.confirm(
          "session-state: clear the session lock?",
          `The lock row is held by ${lock.holder}, which is still alive. Clear it anyway?`,
        );
        if (!confirmed) {
          ctx.ui.notify(
            "session-state: /state:force-refresh cancelled; the lock row was kept",
            "warning",
          );
          return;
        }
      }
      store.releaseSessionLock(sessionId);
      store.dropSessionCache(sessionId);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `session-state: /state:force-refresh removed the lock row (holder ${
            lock?.holder ?? "none"
          }) and this process's cache; the next read comes from disk`,
          "info",
        );
      }
    },
  });
}
