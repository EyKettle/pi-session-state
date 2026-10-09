import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type ConfiguredLocation =
  | { kind: "unset" }
  | { kind: "invalid" }
  | { kind: "absolute"; path: string };

export interface LocationSources {
  text: string | undefined;
  agentDir: string;
  homeDir: string;
}

// The only reader of sessionState.databasePath: callers hand in the settings
// text and the two directories, so the resolution is testable without a
// settings file on disk.
export function resolveConfiguredLocation(
  sources: LocationSources,
): ConfiguredLocation {
  const { text, agentDir, homeDir } = sources;
  if (text === undefined) return { kind: "unset" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "unset" };
  const sessionState = (parsed as Record<string, unknown>).sessionState;
  if (typeof sessionState !== "object" || sessionState === null) {
    return { kind: "unset" };
  }
  const value = (sessionState as Record<string, unknown>).databasePath;
  if (value === undefined) return { kind: "unset" };
  if (typeof value !== "string" || value.length === 0) return { kind: "invalid" };

  if (value.startsWith("~")) {
    const rest = value.slice(1);
    if (rest === "") return { kind: "absolute", path: homeDir };
    return {
      kind: "absolute",
      path: join(homeDir, rest.startsWith("/") ? rest.slice(1) : rest),
    };
  }
  if (isAbsolute(value)) return { kind: "absolute", path: value };
  return { kind: "absolute", path: join(agentDir, value) };
}

// A missing or unreadable settings file means no configured value.
export function readSettingsText(agentDir: string): string | undefined {
  try {
    return readFileSync(join(agentDir, "settings.json"), "utf8");
  } catch {
    return undefined;
  }
}
