/**
 * Phase B / Item 3.2 — built-in plugin loader smoke test.
 * Verifies that the production `loadPlugin` can resolve
 * the built-in samples by name (not just the test
 * harness's custom file paths).
 */
import { describe, expect, it } from "vitest";
import {
  auditLogPlugin,
  calculatorPlugin,
  confirmToolPlugin,
  loadPlugin,
  resolvePluginAllowList,
} from "../../src/index.js";

describe("loadPlugin: built-in samples", () => {
  const allowList = resolvePluginAllowList();
  it("loads envoy-harness-plugin-audit-log via the production path", async () => {
    const loaded = await loadPlugin({
      modulePath: "envoy-harness-plugin-audit-log",
      allowList,
    });
    expect(loaded.module.name).toBe("envoy-harness-plugin-audit-log");
    expect(loaded.module).toBe(auditLogPlugin);
  });

  it("loads envoy-harness-plugin-confirm-tool", async () => {
    const loaded = await loadPlugin({
      modulePath: "envoy-harness-plugin-confirm-tool",
      allowList,
    });
    expect(loaded.module.name).toBe("envoy-harness-plugin-confirm-tool");
    expect(loaded.module).toBe(confirmToolPlugin);
  });

  it("loads envoy-harness-plugin-calculator", async () => {
    const loaded = await loadPlugin({
      modulePath: "envoy-harness-plugin-calculator",
      allowList,
    });
    expect(loaded.module.name).toBe("envoy-harness-plugin-calculator");
    expect(loaded.module).toBe(calculatorPlugin);
  });
});
