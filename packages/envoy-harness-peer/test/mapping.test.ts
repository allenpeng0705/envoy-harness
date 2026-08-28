/**
 * Mapping tests: the MeshSubmitter ↔ MAP shape translation.
 */

import { describe, expect, it } from "vitest";

import { signedResultToSubagentResult } from "../src/index.js";

function wire(overrides: { content?: unknown[] } = {}) {
  return {
    skillId: "research",
    runtime: "envoy-harness",
    peerId: "w1",
    correlationId: "c",
    content: overrides.content ?? [{ kind: "text", text: "hello" }],
    citations: [],
    metrics: { durationMs: 1, costUsd: 0 },
    completedAt: new Date().toISOString(),
    signature: "",
  } as never;
}

describe("signedResultToSubagentResult", () => {
  it("reports failed status when the result has no content (mirrors LocalMeshSubmitter)", () => {
    const result = signedResultToSubagentResult(wire({ content: [] }));
    expect(result.status).toBe("failed");
    expect(result.verdict.kind).toBe("fail");
  });

  it("reports completed for a text result and passes the text through", () => {
    const result = signedResultToSubagentResult(wire());
    expect(result.status).toBe("completed");
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("prefers a real server verdict over the v1 placeholder (fail overrides non-empty content)", () => {
    const result = signedResultToSubagentResult(wire(), {
      kind: "fail",
      reason: "verifier says the answer is wrong",
      rollback: true,
    });
    expect(result.status).toBe("failed");
    expect(result.verdict).toEqual({
      kind: "fail",
      reason: "verifier says the answer is wrong",
      rollback: true,
    });
  });

  it("prefers a real server verdict over the v1 placeholder (pass overrides empty content)", () => {
    const result = signedResultToSubagentResult(wire({ content: [] }), {
      kind: "pass",
      score: 0.9,
      confidence: "high",
    });
    expect(result.status).toBe("completed");
    expect(result.verdict).toEqual({
      kind: "pass",
      score: 0.9,
      confidence: "high",
    });
  });
});
