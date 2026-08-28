/**
 * Phase B / Item 3.1 — plugin loader tests.
 *
 * **Hermetic:** every test creates a temp JS file
 * representing a `CapabilityModule`, builds a custom
 * allow-list including the temp file's path, loads it
 * via `loadPlugin`, then deletes the temp file in
 * `afterEach`.
 *
 * **Coverage:**
 * 1. A module that exports a valid `CapabilityModule`
 *    → loaded + the module is returned.
 * 2. A module with no default export → `PluginLoadError`.
 * 3. A module with a default export missing `name` →
 *    `PluginLoadError`.
 * 4. A module with a default export missing `apply` →
 *    `PluginLoadError`.
 * 5. A name NOT in the allow-list → `PluginLoadError`
 *    (security boundary).
 * 6. A module path that throws on import → `PluginLoadError`.
 * 7. The built-in plugin samples load via the
 *    production `loadPlugin` path. Covered in
 *    `loader-builtins.test.ts` (the chunk 3.2
 *    follow-up that added the built-in map to
 *    the loader).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  PluginLoadError,
  loadPlugin,
  resolvePluginAllowList,
  type ResolvedPluginAllowList,
} from "../../src/index.js";

let tmpDir: string;
let allowList: ResolvedPluginAllowList;
let extraNames: Set<string>;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-plugin-loader-"));
  // Each test starts with a fresh, empty allow-list
  // (no built-ins, no extras) and grows it as
  // `writePlugin` adds temp file paths. This isolates
  // tests from each other and from the production
  // whitelist.
  extraNames = new Set<string>();
  allowList = resolvePluginAllowList({
    builtin: new Set<string>(),
    configured: [],
  });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Write a JS file at `<tmpDir>/<name>.js` with the
 * given source, and add the absolute path to the
 * per-test allow-list. Returns the absolute path.
 */
async function writePlugin(name: string, source: string): Promise<string> {
  const file = path.join(tmpDir, `${name}.js`);
  await writeFile(file, source, "utf8");
  extraNames.add(file);
  allowList = resolvePluginAllowList({
    builtin: new Set<string>(),
    configured: [...extraNames],
  });
  return file;
}

// ---------------------------------------------------------------------------
// 1. Valid module
// ---------------------------------------------------------------------------

describe("loadPlugin: happy path", () => {
  it("loads a module with a valid `CapabilityModule` default export", async () => {
    const file = await writePlugin(
      "valid-plugin",
      `
const module = {
  name: "valid-plugin",
  apply() { return undefined; },
};
export default module;
`,
    );
    const loaded = await loadPlugin({ modulePath: file, allowList });
    expect(loaded.module.name).toBe("valid-plugin");
    expect(typeof loaded.module.apply).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 2. Missing default export
// ---------------------------------------------------------------------------

describe("loadPlugin: invalid modules", () => {
  it("throws on a module with no default export", async () => {
    const file = await writePlugin(
      "no-default",
      `export const x = 1;`,
    );
    await expect(loadPlugin({ modulePath: file, allowList })).rejects.toThrow(
      PluginLoadError,
    );
    await expect(loadPlugin({ modulePath: file, allowList })).rejects.toThrow(
      /no default export/,
    );
  });

  it("throws when the default export is missing `name`", async () => {
    const file = await writePlugin(
      "no-name",
      `export default { apply() {} };`,
    );
    await expect(loadPlugin({ modulePath: file, allowList })).rejects.toThrow(
      /missing 'name'/,
    );
  });

  it("throws when the default export is missing `apply`", async () => {
    const file = await writePlugin(
      "no-apply",
      `export default { name: "x" };`,
    );
    await expect(loadPlugin({ modulePath: file, allowList })).rejects.toThrow(
      /missing 'apply'/,
    );
  });

  it("throws when the module path fails to import", async () => {
    // The path is a temp file (so the allow-list check
    // passes), but the file does not exist on disk.
    const ghost = path.join(tmpDir, "does-not-exist.js");
    extraNames.add(ghost);
    allowList = resolvePluginAllowList({
      builtin: new Set<string>(),
      configured: [...extraNames],
    });
    await expect(
      loadPlugin({ modulePath: ghost, allowList }),
    ).rejects.toThrow(/failed to import plugin module/);
  });
});

// ---------------------------------------------------------------------------
// 3. Allow-list (security boundary)
// ---------------------------------------------------------------------------

describe("loadPlugin: allow-list", () => {
  it("rejects a name NOT in the allow-list", async () => {
    // The path is real (the file exists), but the
    // name isn't in the allow-list. The allow-list
    // check fires BEFORE the import.
    const file = await writePlugin(
      "real-file",
      `export default { name: "x", apply() {} };`,
    );
    // Build a NEW allow-list that excludes the temp path.
    const strictList = resolvePluginAllowList({
      builtin: new Set<string>(),
      configured: [],
    });
    await expect(
      loadPlugin({ modulePath: file, allowList: strictList }),
    ).rejects.toThrow(/not in allow-list/);
  });

  it("accepts a name in the allow-list", async () => {
    const file = await writePlugin(
      "in-allow-list",
      `export default { name: "x", apply() {} };`,
    );
    const loaded = await loadPlugin({ modulePath: file, allowList });
    expect(loaded.module.name).toBe("x");
  });
});
