/**
 * R6.1 — Package-1 re-exports `@envoymesh/envoy-process` killProcessTree.
 * Full coverage (incl. win32 taskkill) lives in packages/envoy-process/test.
 */

import { describe, expect, it } from "vitest";

describe("killProcessTree (re-export)", () => {
  it("is exported from Package 1", async () => {
    const { killProcessTree } = await import("../src/process/kill-tree.js");
    expect(typeof killProcessTree).toBe("function");
    expect(() => killProcessTree(undefined)).not.toThrow();
  });
});
