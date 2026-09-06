/**
 * R4.17 — workflow parallel / pipeline hermetic tests.
 */

import { describe, expect, it } from "vitest";

import {
  parallel,
  pipeline,
  type MeshSubmitter,
  type SubagentInput,
  type SubagentResult,
} from "../src/index.js";

function okResult(
  text: string,
  overrides: Partial<SubagentResult> = {},
): SubagentResult {
  return {
    status: "completed",
    content: [{ type: "text", text }],
    workerPeerId: "local",
    workerRuntime: "envoy-harness",
    costUsd: 0.01,
    durationMs: 1,
    verdict: { kind: "pass", score: 1, confidence: "high" },
    signature: "",
    ...overrides,
  };
}

function scriptedSubmitter(
  handler: (input: SubagentInput) => Promise<SubagentResult> | SubagentResult,
): MeshSubmitter {
  return {
    async submit(input, signal) {
      if (signal.aborted) throw new Error("aborted");
      return handler(input);
    },
  };
}

const base = {
  capabilityTag: "test",
  costCeilingUsd: 1,
  deadlineMs: 5_000,
};

describe("R4.17 workflow.parallel", () => {
  it("runs tasks concurrently and aggregates", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const submitter = scriptedSubmitter(async (input) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return okResult(`done:${input.objective}`);
    });
    const out = await parallel(submitter, [
      { ...base, objective: "a" },
      { ...base, objective: "b" },
      { ...base, objective: "c" },
    ]);
    expect(out.results).toHaveLength(3);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(
      out.results.map((r) =>
        r.content.find((b) => b.type === "text" && "text" in b),
      ),
    ).toBeTruthy();
    expect(out.aggregated.status).toBe("completed");
  });

  it("refuses when tasks exceed maxSubagents", async () => {
    const submitter = scriptedSubmitter(() => okResult("x"));
    await expect(
      parallel(
        submitter,
        [
          { ...base, objective: "a" },
          { ...base, objective: "b" },
        ],
        { maxSubagents: 1 },
      ),
    ).rejects.toThrow(/maxSubagents/);
  });

  it("forwards preferredPeerId (peer:// routing hint)", async () => {
    const seen: Array<string | undefined> = [];
    const submitter = scriptedSubmitter((input) => {
      seen.push(input.preferredPeerId);
      return okResult("ok");
    });
    await parallel(submitter, [
      { ...base, objective: "a", preferredPeerId: "peer://worker-1" },
      { ...base, objective: "b" },
    ]);
    expect(seen).toEqual(["peer://worker-1", undefined]);
  });
});

describe("R4.17 workflow.pipeline", () => {
  it("passes prior step context into the next objective", async () => {
    const objectives: string[] = [];
    const submitter = scriptedSubmitter((input) => {
      objectives.push(input.objective);
      return okResult(`out-${objectives.length}`);
    });
    const out = await pipeline(submitter, [
      { ...base, objective: "step-1" },
      { ...base, objective: "step-2" },
    ]);
    expect(out.results).toHaveLength(2);
    expect(objectives[0]).toBe("step-1");
    expect(objectives[1]).toContain("step-2");
    expect(objectives[1]).toContain("Context from previous step:");
    expect(objectives[1]).toContain("out-1");
    expect(out.final.status).toBe("completed");
  });

  it("stops early on failed step", async () => {
    let calls = 0;
    const submitter = scriptedSubmitter(() => {
      calls++;
      if (calls === 1) {
        return okResult("fail", {
          status: "failed",
          verdict: { kind: "fail", reason: "nope", rollback: false },
        });
      }
      return okResult("should-not-run");
    });
    const out = await pipeline(submitter, [
      { ...base, objective: "a" },
      { ...base, objective: "b" },
    ]);
    expect(calls).toBe(1);
    expect(out.results).toHaveLength(1);
    expect(out.final.status).toBe("failed");
  });
});
