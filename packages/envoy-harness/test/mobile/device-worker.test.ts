/**
 * Mesh device-worker helpers.
 */

import { describe, expect, it } from "vitest";

import {
  DEVICE_WORKER_CAPABILITY,
  DEVICE_WORKER_TOOL_NAMES,
  deviceWorkerCapabilities,
  deviceWorkerRoutingHint,
} from "../../src/mobile/device-worker.js";

describe("device-worker", () => {
  it("advertises device-worker capability", () => {
    expect(deviceWorkerCapabilities()).toEqual([DEVICE_WORKER_CAPABILITY]);
    expect(deviceWorkerCapabilities({ extraCapabilities: ["gpu"] })).toEqual([
      DEVICE_WORKER_CAPABILITY,
      "gpu",
    ]);
  });

  it("lists device_* tool names", () => {
    expect(DEVICE_WORKER_TOOL_NAMES).toContain("device_list");
    expect(DEVICE_WORKER_TOOL_NAMES).toContain("device_screenshot");
  });

  it("routing hint mentions capability", () => {
    expect(deviceWorkerRoutingHint()).toContain(DEVICE_WORKER_CAPABILITY);
  });
});
