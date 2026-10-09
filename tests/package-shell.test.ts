import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
});
