import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type ConfiguredLocation =
  | { kind: "unset" }
  | { kind: "malformed" }
  | { kind: "invalid" }
  | { kind: "unsupported" }
  | { kind: "absolute"; path: string };

export interface LocationSources {
  text: string | undefined;
  baseDir: string;
  homeDir: string;
}

// The only reader of sessionState.databasePath: callers hand in the settings
// text and the directories, so the resolution is testable without a settings
// file on disk. A relative value resolves under the base directory it is
// given: the agent directory for the user file, the project .pi for the
// project file.
export function resolveConfiguredLocation(
  sources: LocationSources,
): ConfiguredLocation {
  const { text, baseDir, homeDir } = sources;
  if (text === undefined) return { kind: "unset" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
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
    if (value === "~") return { kind: "absolute", path: homeDir };
    if (value.startsWith("~/")) {
      return { kind: "absolute", path: join(homeDir, value.slice(2)) };
    }
    return { kind: "unsupported" };
  }
  if (isAbsolute(value)) return { kind: "absolute", path: value };
  return { kind: "absolute", path: join(baseDir, value) };
}

// A missing or unreadable settings file means no configured value.
export function readSettingsText(settingsDir: string): string | undefined {
  try {
    return readFileSync(join(settingsDir, "settings.json"), "utf8");
  } catch {
    return undefined;
  }
}

export type ConfiguredState =
  | "used"
  | "unset"
  | "malformed"
  | "invalid"
  | "unsupported";

export interface DatabaseLocation {
  path: string;
  configured: ConfiguredState;
  source?: string;
}

export interface DatabaseLocationInputs {
  agentDir: string;
  homeDir: string;
  projectDir?: string;
  projectTrusted?: boolean;
}

// The four sources, first hit wins: the integration parameter is applied by
// the caller; here the project file (only while the project is trusted) and
// the agent file are read, and the default under the agent directory is the
// fallback.
export function resolveDatabaseLocation(
  inputs: DatabaseLocationInputs,
): DatabaseLocation {
  const { agentDir, homeDir, projectDir, projectTrusted = false } = inputs;
  const agentSource = join(agentDir, "settings.json");
  const projectSource =
    projectDir === undefined ? undefined : join(projectDir, "settings.json");

  const project: ConfiguredLocation =
    projectDir !== undefined && projectTrusted
      ? resolveConfiguredLocation({
          text: readSettingsText(projectDir),
          baseDir: projectDir,
          homeDir,
        })
      : { kind: "unset" };
  if (project.kind === "absolute") {
    return { path: project.path, configured: "used", source: projectSource };
  }

  const agent = resolveConfiguredLocation({
    text: readSettingsText(agentDir),
    baseDir: agentDir,
    homeDir,
  });
  if (agent.kind === "absolute") {
    return { path: agent.path, configured: "used", source: agentSource };
  }

  const defaultPath = join(agentDir, "sessions", "states.sqlite");
  if (project.kind !== "unset") {
    return { path: defaultPath, configured: project.kind, source: projectSource };
  }
  if (agent.kind !== "unset") {
    return { path: defaultPath, configured: agent.kind, source: agentSource };
  }
  return { path: defaultPath, configured: "unset" };
}
