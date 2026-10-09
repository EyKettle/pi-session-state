import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-state-shell-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Pi loads a subdirectory of the extensions directory only when it declares a
// non-empty `pi.extensions`, or carries a root `index.ts` / `index.js`
// (pi-1.1.0 loader.ts -> resolveExtensionEntries). This package must stay
// invisible to that discovery so it can sit in the extensions tree as a library.
describe("package shell", () => {
  it("has no root extension entry point", () => {
    expect(existsSync(join(packageRoot, "index.ts"))).toBe(false);
    expect(existsSync(join(packageRoot, "index.js"))).toBe(false);
  });

  it("declares no pi.extensions in the manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { pi?: { extensions?: string[] } };
    expect(manifest.pi?.extensions ?? []).toEqual([]);
  });

  it("Pi's extension discovery skips the package (real pi, isolated agent dir)", () => {
    const agentDir = scratch();
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    symlinkSync(packageRoot, join(agentDir, "extensions", "session-state"));
    const runPi = () =>
      spawnSync("pi", ["-p", "--offline"], {
        cwd: agentDir,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        encoding: "utf8",
        timeout: 60_000,
      });

    const clean = runPi();
    const cleanOutput = `${clean.stdout ?? ""}${clean.stderr ?? ""}`;
    expect(clean.status).toBe(0);
    expect(cleanOutput).not.toContain("Failed to load extension");

    // Negative control: the same assertion must see a real load failure.
    writeFileSync(join(agentDir, "extensions", "broken.ts"), "export default function (");
    const broken = runPi();
    const brokenOutput = `${broken.stdout ?? ""}${broken.stderr ?? ""}`;
    expect(brokenOutput).toContain("Failed to load extension");
    expect(broken.status).not.toBe(0);
  }, 60_000);
});
