import { homedir } from "node:os";
import { getAgentDir } from "../deps/pi-coding-agent.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
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
}
