/**
 * Phase G / Item 3 (Review 3 / Medium 4) — allow-list tests.
 *
 * **Hermetic:** the allow-list is a pure function over
 * a set. Tests don't touch the filesystem or the
 * network.
 *
 * **Coverage:**
 * 1. Default `resolvePluginAllowList()` returns the
 *    in-binary built-in whitelist unchanged.
 * 2. `resolvePluginAllowList({ configured })` unions
 *    the built-in and configured sets (deduped).
 * 3. Empty / whitespace-only configured entries are
 *    skipped (defense in depth — the schema already
 *    rejects empties, but programmatic callers can
 *    bypass it).
 * 4. `isAllowedPlugin` membership check.
 * 5. The user's allow-list enables a previously-
 *    unallowed name (regression for the "hardcoded
 *    source set" complaint in the external review).
 */

import { describe, expect, it } from "vitest";

import {
  isAllowedPlugin,
  resolvePluginAllowList,
} from "../../src/index.js";

describe("resolvePluginAllowList (default)", () => {
  it("returns the in-binary built-in whitelist when no config is supplied", () => {
    const { allow, builtin } = resolvePluginAllowList();
    // The default builtin is the in-binary whitelist
    // (the 3 samples: audit-log, confirm-tool,
    // calculator).
    expect(builtin.has("envoy-harness-plugin-audit-log")).toBe(true);
    expect(builtin.has("envoy-harness-plugin-confirm-tool")).toBe(true);
    expect(builtin.has("envoy-harness-plugin-calculator")).toBe(true);
    // The merged `allow` is a superset of `builtin`
    // (in this case, equal).
    expect(allow.has("envoy-harness-plugin-audit-log")).toBe(true);
    // No user-configured entries → no extras.
    expect(allow.size).toBe(builtin.size);
  });
});

describe("resolvePluginAllowList (user-configured)", () => {
  it("unions the built-in and configured sets (no duplicates)", () => {
    const { allow, builtin } = resolvePluginAllowList({
      configured: ["@my-org/my-plugin", "file:///abs/path/plugin.js"],
    });
    // Built-ins are still in the merged set.
    expect(allow.has("envoy-harness-plugin-audit-log")).toBe(true);
    // User-configured entries are added.
    expect(allow.has("@my-org/my-plugin")).toBe(true);
    expect(allow.has("file:///abs/path/plugin.js")).toBe(true);
    // No duplicates — `builtin` is a subset of `allow`.
    for (const name of builtin) {
      expect(allow.has(name)).toBe(true);
    }
    // Size grows by exactly the number of NEW
    // configured entries (no overlap with built-in).
    expect(allow.size).toBe(builtin.size + 2);
  });

  it("dedupes when a user puts a built-in name in their allow list", () => {
    const { allow, builtin } = resolvePluginAllowList({
      configured: ["envoy-harness-plugin-audit-log", "my-extra"],
    });
    // The size grows by 1, not 2 — the built-in was
    // already in the set.
    expect(allow.size).toBe(builtin.size + 1);
    expect(allow.has("envoy-harness-plugin-audit-log")).toBe(true);
    expect(allow.has("my-extra")).toBe(true);
  });

  it("skips empty / whitespace-only configured entries", () => {
    const { allow, builtin } = resolvePluginAllowList({
      configured: ["", "   ", "real-entry"],
    });
    expect(allow.size).toBe(builtin.size + 1);
    expect(allow.has("real-entry")).toBe(true);
    expect(allow.has("")).toBe(false);
    expect(allow.has("   ")).toBe(false);
  });

  it("returns an allow-list whose `builtin` sub-set is exactly the built-ins", () => {
    const { builtin, allow } = resolvePluginAllowList({
      configured: ["my-extra"],
    });
    // `builtin` is the in-binary whitelist regardless
    // of user config — that's how the loader
    // distinguishes "ship in this package" from
    // "user added this".
    expect(builtin.has("my-extra")).toBe(false);
    expect(allow.has("my-extra")).toBe(true);
  });
});

describe("isAllowedPlugin", () => {
  it("returns true for names in the allow-list", () => {
    const list = resolvePluginAllowList({ configured: ["my-plugin"] });
    expect(isAllowedPlugin("my-plugin", list)).toBe(true);
    expect(isAllowedPlugin("envoy-harness-plugin-audit-log", list)).toBe(true);
  });

  it("returns false for names NOT in the allow-list", () => {
    const list = resolvePluginAllowList();
    expect(isAllowedPlugin("not-a-plugin", list)).toBe(false);
  });
});

describe("allow-list enables a previously-unallowed name (regression for Medium 4)", () => {
  it("a name in the user's allow-list but not in the built-in whitelist is loadable", () => {
    // Before the fix, the only way to add a plugin
    // was to edit `src/plugins/whitelist.ts` and
    // recompile. The new `plugins.allow` config field
    // lets a user extend the allow-list at runtime
    // without source edits — the loader's check is
    // membership in the resolved set, not the
    // hardcoded source set.
    const { allow, builtin } = resolvePluginAllowList({
      configured: ["my-org/my-external-plugin"],
    });
    expect(builtin.has("my-org/my-external-plugin")).toBe(false);
    expect(allow.has("my-org/my-external-plugin")).toBe(true);
    expect(isAllowedPlugin("my-org/my-external-plugin", { allow, builtin })).toBe(
      true,
    );
  });
});
