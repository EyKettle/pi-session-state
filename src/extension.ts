import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../deps/pi-coding-agent.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "../deps/pi-coding-agent.ts";
import { resolveDatabaseLocation } from "./settings.ts";
import { holderStatus, openStore, type SessionStore } from "./store.ts";
import { publishLocation } from "./authority.ts";

function holderState(holder: string): string {
  const status = holderStatus(holder);
  return status === "not-alive" ? "not alive" : status;
}

function statusLines(
  databasePath: string,
  sessionId: string,
  store: SessionStore,
): string[] {
  const report = store.inspectSession(sessionId);
  const lock =
    report.lock === undefined
      ? "lock: none"
      : `lock: ${report.lock.holder} (${holderState(report.lock.holder)})`;
  const rows =
    report.rowsByPlugin.length === 0
      ? "state rows: none"
      : `state rows: ${report.rowsByPlugin
          .map((entry) => `${entry.pluginId}: ${entry.count}`)
          .join(", ")}`;
  return ["session-state /state:status", `database: ${databasePath}`, lock, rows];
}

// The Pi entry: package.json's pi.extensions points here. It starts no
// long-lived resource; the location is resolved at session start, where the
// context carries the project directory and the trust state.
export default function extension(pi: ExtensionAPI): void {
  let current: { path: string; store: SessionStore } | undefined;

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext): void => {
    const location = resolveDatabaseLocation({
      agentDir: getAgentDir(),
      homeDir: homedir(),
      projectDir: join(ctx.cwd, CONFIG_DIR_NAME),
      projectTrusted: ctx.isProjectTrusted(),
    });
    publishLocation(location);
    current = { path: location.path, store: openStore(location.path) };

    if (!ctx.hasUI) return;
    const fallback = `using the default location ${location.path}`;
    if (location.configured === "malformed") {
      ctx.ui.notify(
        `session-state: the settings file ${location.source} is not valid JSON; ${fallback}`,
        "warning",
      );
    } else if (location.configured === "invalid") {
      ctx.ui.notify(
        `session-state: the sessionState.databasePath setting in ${location.source} is not a non-empty string; ${fallback}`,
        "warning",
      );
    } else if (location.configured === "unsupported") {
      ctx.ui.notify(
        `session-state: the sessionState.databasePath setting in ${location.source} uses a "~user" form the contract cannot express; ${fallback}`,
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
      if (!ctx.hasUI || current === undefined) return;
      const lines = statusLines(
        current.path,
        ctx.sessionManager.getSessionId(),
        current.store,
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
      if (current === undefined) return;
      const sessionId = ctx.sessionManager.getSessionId();
      const lock = current.store.inspectSession(sessionId).lock;
      if (lock !== undefined && holderStatus(lock.holder) !== "not-alive") {
        if (!ctx.hasUI) return;
        const confirmed = await ctx.ui.confirm(
          "session-state: clear the session lock?",
          `The lock row is held by ${lock.holder} (${holderState(lock.holder)}). Clear it anyway?`,
        );
        if (!confirmed) {
          ctx.ui.notify(
            "session-state: /state:force-refresh cancelled; the lock row was kept",
            "warning",
          );
          return;
        }
      }
      current.store.releaseSessionLock(sessionId);
      current.store.dropSessionCache(sessionId);
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
