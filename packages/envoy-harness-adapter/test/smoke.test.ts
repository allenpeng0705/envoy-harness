/**
 * Smoke test — confirms the package builds, imports, and the
 * public surface is reachable. Real tests live in skill,
 * adapter, translation, execute, verify test files (F8.1+).
 */

import { describe, expect, it } from "vitest";

import { ENVOY_HARNESS_ADAPTER_VERSION } from "../src/index.js";

describe("envoy-harness-adapter smoke", () => {
  it("exports a version constant", () => {
    expect(ENVOY_HARNESS_ADAPTER_VERSION).toBe("0.0.0");
  });

  it("can be imported as an ES module", () => {
    // The import above already proves this. Assert one more
    // thing so the test isn't vacuous.
    expect(typeof ENVOY_HARNESS_ADAPTER_VERSION).toBe("string");
  });
});
