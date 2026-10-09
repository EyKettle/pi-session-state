import { describe, expect, it } from "vitest";
import { resolveConfiguredLocation } from "../src/settings.ts";

const agentDir = "/agent";
const homeDir = "/home/user";

function resolve(text: string | undefined) {
  return resolveConfiguredLocation({ text, agentDir, homeDir });
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

  it("resolves a relative value under the agent directory", () => {
    expect(resolve('{"sessionState":{"databasePath":"state/db.sqlite"}}')).toEqual({
      kind: "absolute",
      path: "/agent/state/db.sqlite",
    });
  });
});
