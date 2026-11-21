/**
 * Mesh browser-worker helpers.
 */

import { describe, expect, it } from "vitest";

import {
  BROWSER_WORKER_CAPABILITY,
  BROWSER_WORKER_TOOL_NAMES,
  browserWorkerCapabilities,
  browserWorkerRoutingHint,
} from "../../src/web/browser-worker.js";

describe("browser-worker", () => {
  it("advertises browser-worker capability", () => {
    expect(browserWorkerCapabilities()).toEqual([BROWSER_WORKER_CAPABILITY]);
    expect(browserWorkerCapabilities({ extraCapabilities: ["gpu"] })).toEqual([
      BROWSER_WORKER_CAPABILITY,
      "gpu",
    ]);
  });

  it("lists browser_* tools", () => {
    expect(BROWSER_WORKER_TOOL_NAMES).toContain("browser_navigate");
    expect(BROWSER_WORKER_TOOL_NAMES).toContain("browser_screenshot");
  });

  it("routing hint mentions capability", () => {
    expect(browserWorkerRoutingHint()).toContain(BROWSER_WORKER_CAPABILITY);
  });
});
