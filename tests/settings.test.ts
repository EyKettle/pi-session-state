import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveConfiguredLocation,
  resolveDatabaseLocation,
} from "../src/settings.ts";

const agentDir = "/agent";
const homeDir = "/home/user";

function resolve(text: string | undefined) {
  return resolveConfiguredLocation({ text, baseDir: agentDir, homeDir });
}

describe("configured storage location", () => {
  it("treats an absent settings file as unset", () => {
    expect(resolve(undefined)).toEqual({ kind: "unset" });
  });

  it("treats a missing key as unset", () => {
    expect(resolve("{}")).toEqual({ kind: "unset" });
    expect(resolve('{"sessionState":{}}')).toEqual({ kind: "unset" });
    expect(resolve('{"sessionState":"x"}')).toEqual({ kind: "unset" });
  });

  it("treats a value that is not a non-empty string as invalid", () => {
    expect(resolve('{"sessionState":{"databasePath":42}}')).toEqual({ kind: "invalid" });
    expect(resolve('{"sessionState":{"databasePath":""}}')).toEqual({ kind: "invalid" });
    expect(resolve('{"sessionState":{"databasePath":null}}')).toEqual({ kind: "invalid" });
  });

  it("treats an unparsable settings file as malformed", () => {
    expect(resolve("not json")).toEqual({ kind: "malformed" });
  });

  it("keeps an absolute value as it stands", () => {
    expect(resolve('{"sessionState":{"databasePath":"/abs/db.sqlite"}}')).toEqual({
      kind: "absolute",
      path: "/abs/db.sqlite",
    });
  });

  it("expands a ~ value against the home directory", () => {
    expect(resolve('{"sessionState":{"databasePath":"~/data/db.sqlite"}}')).toEqual({
      kind: "absolute",
      path: "/home/user/data/db.sqlite",
    });
    expect(resolve('{"sessionState":{"databasePath":"~"}}')).toEqual({
      kind: "absolute",
      path: "/home/user",
    });
  });

  it("treats a ~user value as unsupported", () => {
    expect(resolve('{"sessionState":{"databasePath":"~other/db.sqlite"}}')).toEqual({
      kind: "unsupported",
    });
  });

  it("resolves a relative value under the base directory", () => {
    expect(resolve('{"sessionState":{"databasePath":"state/db.sqlite"}}')).toEqual({
      kind: "absolute",
      path: "/agent/state/db.sqlite",
    });
  });
});

describe("database location sources", () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "session-state-settings-"));
    scratchDirs.push(dir);
    return dir;
  }

  function writeSettings(dir: string, text: string): void {
    writeFileSync(join(dir, "settings.json"), text);
  }

  function settings(databasePath: unknown): string {
    return JSON.stringify({ sessionState: { databasePath } });
  }

  function settingsPath(dir: string): string {
    return join(dir, "settings.json");
  }

  it("the trusted project file overrides the agent file", () => {
    const agent = scratch();
    const project = scratch();
    writeSettings(agent, settings(join(agent, "agent.sqlite")));
    writeSettings(project, settings(join(project, "project.sqlite")));

    expect(
      resolveDatabaseLocation({
        agentDir: agent,
        homeDir,
        projectDir: project,
        projectTrusted: true,
      }),
    ).toEqual({
      path: join(project, "project.sqlite"),
      configured: "used",
      source: settingsPath(project),
    });
  });

  it("an untrusted project file is ignored and the agent file applies", () => {
    const agent = scratch();
    const project = scratch();
    writeSettings(agent, settings(join(agent, "agent.sqlite")));
    writeSettings(project, settings(join(project, "project.sqlite")));

    expect(
      resolveDatabaseLocation({
        agentDir: agent,
        homeDir,
        projectDir: project,
        projectTrusted: false,
      }),
    ).toEqual({
      path: join(agent, "agent.sqlite"),
      configured: "used",
      source: settingsPath(agent),
    });
  });

  it("resolves a relative agent value under the agent directory and a relative project value under the project directory", () => {
    const agent = scratch();
    const project = scratch();
    writeSettings(agent, settings("state/db.sqlite"));
    writeSettings(project, settings("state/db.sqlite"));

    expect(
      resolveDatabaseLocation({
        agentDir: agent,
        homeDir,
        projectDir: project,
        projectTrusted: true,
      }),
    ).toEqual({
      path: join(project, "state", "db.sqlite"),
      configured: "used",
      source: settingsPath(project),
    });
    expect(resolveDatabaseLocation({ agentDir: agent, homeDir })).toEqual({
      path: join(agent, "state", "db.sqlite"),
      configured: "used",
      source: settingsPath(agent),
    });
  });

  it("falls through an unusable project value to the agent file", () => {
    const agent = scratch();
    const project = scratch();
    writeSettings(agent, settings(join(agent, "agent.sqlite")));
    writeSettings(project, "not json");

    expect(
      resolveDatabaseLocation({
        agentDir: agent,
        homeDir,
        projectDir: project,
        projectTrusted: true,
      }),
    ).toEqual({
      path: join(agent, "agent.sqlite"),
      configured: "used",
      source: settingsPath(agent),
    });
  });

  it("falls back to the default and names the file the cause came from", () => {
    const agent = scratch();
    const project = scratch();
    writeSettings(agent, settings(42));
    writeSettings(project, "not json");

    expect(
      resolveDatabaseLocation({
        agentDir: agent,
        homeDir,
        projectDir: project,
        projectTrusted: true,
      }),
    ).toEqual({
      path: join(agent, "sessions", "states.sqlite"),
      configured: "malformed",
      source: settingsPath(project),
    });
    expect(resolveDatabaseLocation({ agentDir: agent, homeDir })).toEqual({
      path: join(agent, "sessions", "states.sqlite"),
      configured: "invalid",
      source: settingsPath(agent),
    });
  });

  it("reports nothing configured when no file carries the key", () => {
    const agent = scratch();
    const project = scratch();
    writeSettings(project, "{}");

    expect(
      resolveDatabaseLocation({
        agentDir: agent,
        homeDir,
        projectDir: project,
        projectTrusted: true,
      }),
    ).toEqual({
      path: join(agent, "sessions", "states.sqlite"),
      configured: "unset",
    });
  });
});
