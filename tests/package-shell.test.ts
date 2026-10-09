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

// package.json declares pi.extensions -> ./src/extension.ts, and no root
// index.ts / index.js exists, so Pi's discovery (loader.ts ->
// resolveExtensionEntries) resolves the declared entry alone while the
// library entry stays importable by consumers.
describe("package shell", () => {
  it("declares the extension entry and no root entry point", () => {
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { pi?: { extensions?: string[] } };
    expect(manifest.pi?.extensions).toEqual(["./src/extension.ts"]);
    expect(existsSync(join(packageRoot, "src", "extension.ts"))).toBe(true);
    expect(existsSync(join(packageRoot, "index.ts"))).toBe(false);
    expect(existsSync(join(packageRoot, "index.js"))).toBe(false);
  });

  it("Pi loads the package through the declared entry (real pi, isolated agent dir)", () => {
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

    // Negative control 2: a package that declares a broken entry proves Pi
    // loads what a pi.extensions manifest names.
    const brokenPackage = join(agentDir, "extensions", "broken-package");
    mkdirSync(brokenPackage, { recursive: true });
    writeFileSync(
      join(brokenPackage, "package.json"),
      JSON.stringify({
        name: "broken-package",
        pi: { extensions: ["./broken.ts"] },
      }),
    );
    writeFileSync(join(brokenPackage, "broken.ts"), "export default function (");
    const brokenManifest = runPi();
    const brokenManifestOutput = `${brokenManifest.stdout ?? ""}${
      brokenManifest.stderr ?? ""
    }`;
    expect(brokenManifestOutput).toContain("Failed to load extension");
  }, 60_000);
});
