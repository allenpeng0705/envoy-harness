/**
 * Activity formatting for protocol trace → TUI.
 */

import { describe, expect, it } from "vitest";

import { traceEventToActivity } from "../../src/protocol/activity-format.js";

describe("traceEventToActivity", () => {
  it("summarizes task tool as sub-agent spawn", () => {
    const a = traceEventToActivity({
      kind: "tool_call",
      ts: "2026-01-01T00:00:00.000Z",
      iteration: 1,
      call: {
        id: "c1",
        name: "task",
        args: {
          objective: "review the auth module",
          preferredRuntime: "openclaw",
        },
      },
    });
    expect(a.kind).toBe("tool_call");
    expect(a.summary).toContain("sub-agent");
    expect(a.summary).toContain("openclaw");
  });

  it("summarizes agent_end with cost", () => {
    const a = traceEventToActivity({
      kind: "agent_end",
      ts: "2026-01-01T00:00:00.000Z",
      stopReason: "end_turn",
      iterations: 3,
      toolCalls: 2,
      metrics: { inputTokens: 100, outputTokens: 50, costUsd: 0.0123 },
    });
    expect(a.summary).toContain("done");
    expect(a.costUsd).toBe(0.0123);
  });
});
