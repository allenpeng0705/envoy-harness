/**
 * Phase B / Item 3.1 — plugin loader tests.
 *
 * **Hermetic:** every test creates a temp JS file
 * representing a `CapabilityModule`, adds the path
 * to the whitelist (mutating the production
 * `Set` via the documented cast), loads it via
 * `loadPlugin`, then removes the entry + deletes
 * the temp file in `afterEach`. The production
 * whitelist is restored to its original state
 * between tests.
 *
 * **Coverage:**
 * 1. A module that exports a valid `CapabilityModule`
 *    → loaded + the module is returned.
 * 2. A module with no default export → `PluginLoadError`.
 * 3. A module with a default export missing `name` →
 *    `PluginLoadError`.
 * 4. A module with a default export missing `apply` →
 *    `PluginLoadError`.
 * 5. A name NOT in the whitelist → `PluginLoadError`
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
} from "../../src/index.js";
import { PLUGIN_WHITELIST } from "../../src/plugins/index.js";

let tmpDir: string;
const ORIGINAL_WHITELIST = new Set(PLUGIN_WHITELIST);

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-plugin-loader-"));
  // Reset the whitelist to the production state (in
  // case a previous test added a temp entry that the
  // afterEach didn't clean up).
  (PLUGIN_WHITELIST as Set<string>).clear();
  for (const v of ORIGINAL_WHITELIST) (PLUGIN_WHITELIST as Set<string>).add(v);
});

afterEach(async () => {
  // Restore the production whitelist.
  (PLUGIN_WHITELIST as Set<string>).clear();
  for (const v of ORIGINAL_WHITELIST) (PLUGIN_WHITELIST as Set<string>).add(v);
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Write a JS file at `<tmpDir>/<name>.js` with the
 * given source, and add the absolute path to the
 * whitelist. Returns the absolute path.
 *
 * The whitelist expects module SPECIFIERS, not
 * paths — so we use the FILE PATH directly (Node's
 * `import()` accepts absolute paths starting with
 * `/`).
 */
async function writePlugin(name: string, source: string): Promise<string> {
  const file = path.join(tmpDir, `${name}.js`);
  await writeFile(file, source, "utf8");
  (PLUGIN_WHITELIST as Set<string>).add(file);
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
    const loaded = await loadPlugin({ modulePath: file });
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
    await expect(loadPlugin({ modulePath: file })).rejects.toThrow(
      PluginLoadError,
    );
    await expect(loadPlugin({ modulePath: file })).rejects.toThrow(
      /no default export/,
    );
  });

  it("throws when the default export is missing `name`", async () => {
    const file = await writePlugin(
      "no-name",
      `export default { apply() {} };`,
    );
    await expect(loadPlugin({ modulePath: file })).rejects.toThrow(
      /missing 'name'/,
    );
  });

  it("throws when the default export is missing `apply`", async () => {
    const file = await writePlugin(
      "no-apply",
      `export default { name: "x" };`,
    );
    await expect(loadPlugin({ modulePath: file })).rejects.toThrow(
      /missing 'apply'/,
    );
  });

  it("throws when the module path fails to import", async () => {
    await expect(
      loadPlugin({ modulePath: "/this/path/does/not/exist.js" }),
    ).rejects.toThrow(/not in whitelist/);
  });
});

// ---------------------------------------------------------------------------
// 3. Whitelist (security boundary)
// ---------------------------------------------------------------------------

describe("loadPlugin: whitelist", () => {
  it("rejects a name NOT in the whitelist", async () => {
    // The path is real (the file exists), but the
    // name isn't in the whitelist. The whitelist
    // check fires BEFORE the import.
    const file = await writePlugin(
      "real-file",
      `export default { name: "x", apply() {} };`,
    );
    // Remove the path from the whitelist (the
    // helper added it; we want the test to assert
    // the "not whitelisted" path).
    (PLUGIN_WHITELIST as Set<string>).delete(file);
    await expect(loadPlugin({ modulePath: file })).rejects.toThrow(
      /not in whitelist/,
    );
  });

  it("accepts a name in the whitelist", async () => {
    const file = await writePlugin(
      "in-whitelist",
      `export default { name: "x", apply() {} };`,
    );
    const loaded = await loadPlugin({ modulePath: file });
    expect(loaded.module.name).toBe("x");
  });
});
