/**
 * Hermetic tests for AcpHost + activity + discovery helper paths.
 */
import { describe, expect, it } from "vitest";
import { formatActivityLine } from "../src/client/acp/activity.js";
import { AcpHost } from "../src/client/acp/host.js";

describe("formatActivityLine", () => {
  it("formats tool_call and subagent prefix", () => {
    expect(
      formatActivityLine({
        kind: "tool_call",
        summary: "bash ls",
        toolName: "bash",
      }),
    ).toContain("bash ls");
    expect(
      formatActivityLine({
        kind: "tool_call",
        summary: "read",
        subagentOf: "parent",
      }),
    ).toMatch(/↳/);
  });

  it("skips model_response via empty string", () => {
    expect(
      formatActivityLine({ kind: "model_response", summary: "…" }),
    ).toBe("");
  });
});

describe("AcpHost", () => {
  it("starts idle / disconnected-ready false", () => {
    const host = new AcpHost();
    expect(host.state.connectionState).toBe("idle");
    expect(host.state.ready).toBe(false);
    expect(host.state.mesh).toBeNull();
    host.close();
    expect(host.state.connectionState).toBe("disconnected");
  });

  it("notifies subscribers", () => {
    const host = new AcpHost();
    let ticks = 0;
    const unsub = host.subscribe(() => {
      ticks += 1;
    });
    host.close();
    expect(ticks).toBeGreaterThan(0);
    unsub();
  });
});
