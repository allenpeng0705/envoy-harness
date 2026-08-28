/**
 * Phase B / Item 3.1 + 3.2 — whitelist tests.
 *
 * **Hermetic:** the whitelist is a constant; tests just
 * check membership + the helper.
 *
 * **Coverage:**
 * 1. The built-in `audit-log` is in the whitelist.
 * 2. The built-in `confirm-tool` is in the whitelist
 *    (chunk 3.2).
 * 3. The built-in `calculator` is in the whitelist
 *    (chunk 3.2).
 * 4. An unknown name is NOT in the whitelist.
 * 5. `isWhitelistedPlugin` matches `PLUGIN_WHITELIST.has`.
 * 6. `isBuiltinPlugin` returns true for the built-in
 *    names and false for everything else (chunk 3.2).
 * 7. `getBuiltinPlugin` returns the module for a
 *    built-in name; `undefined` otherwise.
 */

import { describe, expect, it } from "vitest";

import {
  PLUGIN_WHITELIST,
  isWhitelistedPlugin,
} from "../../src/index.js";
import {
  getBuiltinPlugin,
  isBuiltinPlugin,
} from "../../src/plugins/index.js";

describe("PLUGIN_WHITELIST", () => {
  it("contains the built-in audit-log sample", () => {
    expect(PLUGIN_WHITELIST.has("envoy-harness-plugin-audit-log")).toBe(true);
  });

  it("contains the built-in confirm-tool sample (chunk 3.2)", () => {
    expect(PLUGIN_WHITELIST.has("envoy-harness-plugin-confirm-tool")).toBe(true);
  });

  it("contains the built-in calculator sample (chunk 3.2)", () => {
    expect(PLUGIN_WHITELIST.has("envoy-harness-plugin-calculator")).toBe(true);
  });

  it("does not contain unknown plugin names", () => {
    expect(PLUGIN_WHITELIST.has("not-a-real-plugin")).toBe(false);
    expect(PLUGIN_WHITELIST.has("envoy-harness-plugin-malicious")).toBe(false);
  });
});

describe("isWhitelistedPlugin", () => {
  it("matches PLUGIN_WHITELIST membership", () => {
    expect(isWhitelistedPlugin("envoy-harness-plugin-audit-log")).toBe(true);
    expect(isWhitelistedPlugin("envoy-harness-plugin-confirm-tool")).toBe(true);
    expect(isWhitelistedPlugin("envoy-harness-plugin-calculator")).toBe(true);
    expect(isWhitelistedPlugin("not-a-real-plugin")).toBe(false);
  });
});

describe("isBuiltinPlugin + getBuiltinPlugin (chunk 3.2)", () => {
  it("isBuiltinPlugin returns true for the built-in names", () => {
    expect(isBuiltinPlugin("envoy-harness-plugin-audit-log")).toBe(true);
    expect(isBuiltinPlugin("envoy-harness-plugin-confirm-tool")).toBe(true);
    expect(isBuiltinPlugin("envoy-harness-plugin-calculator")).toBe(true);
  });

  it("isBuiltinPlugin returns false for unknown names", () => {
    expect(isBuiltinPlugin("not-a-real-plugin")).toBe(false);
  });

  it("getBuiltinPlugin returns the module for a built-in name", () => {
    const audit = getBuiltinPlugin("envoy-harness-plugin-audit-log");
    expect(audit).toBeDefined();
    expect(audit?.name).toBe("envoy-harness-plugin-audit-log");
  });

  it("getBuiltinPlugin returns undefined for unknown names", () => {
    expect(getBuiltinPlugin("not-a-real-plugin")).toBeUndefined();
  });
});
