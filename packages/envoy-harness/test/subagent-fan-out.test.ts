/**
 * F10.4.1 tests — `FanOutSpec` + `FanOutRegistry` + task-tool fan-out.
 *
 * Covers:
 * 1. Registry: register + lookup + size + clear; one spec
 *    per tag (last write wins).
 * 2. `aggregateFanOutResults` — worst-case status (one
 *    failed → "failed").
 * 3. `aggregateFanOutResults` — concatenated content with
 *    "[sub-agent i/N]" headers in completion order.
 * 4. `aggregateFanOutResults` — costUsd = sum;
 *    durationMs = max.
 * 5. `aggregateFanOutResults` — worst-case verdict
 *    (pass < partial < fail).
 * 6. `aggregateFanOutResults` — empty input throws
 *    (defensive: caller should ensure N >= 1).
 * 7. `task` tool with a registry: ONE model call →
 *    N sub-agents in parallel (F10.2 path: `Promise.all`).
 * 8. `task` tool with a registry: partition function
 *    injects `i` into each sub-agent's input.
 * 9. `task` tool with a registry: identity partition
 *    (no partition function) → each sub-agent gets
 *    the same input.
 * 10. `task` tool with NO registry: F10.1 + F10.2
 *     baseline unchanged (no fan-out, one sub-agent).
 */

import { describe, expect, it } from "vitest";

import {
  type ContentBlock,
  FanOutRegistry,
  type MeshSubmitter,
  type SubagentResult,
  type Tool,
  aggregateFanOutResults,
  makeTaskTool,
} from "@envoymesh/envoy-harness";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

function makeResult(opts: {
  status?: SubagentResult["status"];
  text?: string;
  costUsd?: number;
  durationMs?: number;
  verdictKind?: "pass" | "partial" | "fail";
}): SubagentResult {
  return {
    status: opts.status ?? "completed",
    content: [textBlock(opts.text ?? "default")],
    workerPeerId: "w1",
    workerRuntime: "envoy-harness",
    costUsd: opts.costUsd ?? 0.001,
    durationMs: opts.durationMs ?? 10,
    verdict:
      opts.verdictKind === "fail"
        ? { kind: "fail", reason: "x", rollback: false }
        : opts.verdictKind === "partial"
          ? { kind: "partial", score: 0.5, reason: "x" }
          : { kind: "pass", score: 0.5, confidence: "medium" },
    signature: "",
  };
}

function makeScriptedSubmitter(
  scripted: ReadonlyArray<SubagentResult>,
): { submitter: MeshSubmitter; callCount: number } {
  let callCount = 0;
  const submitter: MeshSubmitter = {
    async submit(_input, _signal) {
      const r = scripted[callCount++];
      if (!r) throw new Error("scripted submitter: responses exhausted");
      return r;
    },
  };
  return { submitter, get callCount() { return callCount; } };
}

const baseArgs = {
  objective: "do x",
  capability_tag: "research",
  cost_ceiling_usd: 0.1,
  deadline_ms: 1000,
} as const;

function makeCtx() {
  return {
    cwd: "/",
    session: {} as never,
    abortSignal: new AbortController().signal,
  };
}

// ---------------------------------------------------------------------------
// 1. Registry basics
// ---------------------------------------------------------------------------

describe("F10.4.1: FanOutRegistry", () => {
  it("register + lookup + size + clear; one spec per tag (last write wins)", () => {
    const registry = new FanOutRegistry();
    expect(registry.size).toBe(0);
    expect(registry.lookup("research")).toBeUndefined();

    registry.register({ capabilityTag: "research", count: 3 });
    expect(registry.size).toBe(1);
    expect(registry.lookup("research")?.count).toBe(3);

    // Re-register: last write wins.
    registry.register({ capabilityTag: "research", count: 5 });
    expect(registry.size).toBe(1);
    expect(registry.lookup("research")?.count).toBe(5);

    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.lookup("research")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2-5. aggregateFanOutResults
// ---------------------------------------------------------------------------

describe("F10.4.1: aggregateFanOutResults", () => {
  it("worst-case status (one failed → 'failed')", () => {
    const results = [
      makeResult({ status: "completed" }),
      makeResult({ status: "failed" }),
      makeResult({ status: "completed" }),
    ];
    const agg = aggregateFanOutResults(results);
    expect(agg.status).toBe("failed");
  });

  it("concatenated content with [sub-agent i/N] headers in completion order", () => {
    const results = [
      makeResult({ text: "first" }),
      makeResult({ text: "second" }),
      makeResult({ text: "third" }),
    ];
    const agg = aggregateFanOutResults(results);
    expect(agg.content).toHaveLength(6); // 3 headers + 3 text blocks
    // Pattern: [header1, text1, header2, text2, header3, text3]
    expect(agg.content[0]).toEqual({ type: "text", text: "[sub-agent 1/3] " });
    expect(agg.content[1]).toEqual({ type: "text", text: "first" });
    expect(agg.content[2]).toEqual({ type: "text", text: "[sub-agent 2/3] " });
    expect(agg.content[3]).toEqual({ type: "text", text: "second" });
    expect(agg.content[4]).toEqual({ type: "text", text: "[sub-agent 3/3] " });
    expect(agg.content[5]).toEqual({ type: "text", text: "third" });
  });

  it("costUsd = sum; durationMs = max (wall-clock the parent waited)", () => {
    const results = [
      makeResult({ costUsd: 0.01, durationMs: 50 }),
      makeResult({ costUsd: 0.02, durationMs: 200 }),
      makeResult({ costUsd: 0.03, durationMs: 100 }),
    ];
    const agg = aggregateFanOutResults(results);
    expect(agg.costUsd).toBeCloseTo(0.06, 5);
    expect(agg.durationMs).toBe(200);
  });

  it("worst-case verdict (fail wins over partial wins over pass)", () => {
    const pass = makeResult({ verdictKind: "pass" });
    const partial = makeResult({ verdictKind: "partial" });
    const fail = makeResult({ verdictKind: "fail" });
    // fail among passes → fail
    expect(aggregateFanOutResults([pass, fail, pass]).verdict.kind).toBe("fail");
    // partial among passes → partial
    expect(aggregateFanOutResults([pass, partial, pass]).verdict.kind).toBe("partial");
    // all pass → pass
    expect(aggregateFanOutResults([pass, pass, pass]).verdict.kind).toBe("pass");
  });

  it("empty input throws (defensive)", () => {
    expect(() => aggregateFanOutResults([])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6-9. task tool with a FanOutRegistry
// ---------------------------------------------------------------------------

describe("F10.4.1: task tool with FanOutRegistry", () => {
  it("ONE model call → N sub-agents in parallel (Promise.all)", async () => {
    // 3 scripted sub-agent results.
    const counter = makeScriptedSubmitter([
      makeResult({ text: "a" }),
      makeResult({ text: "b" }),
      makeResult({ text: "c" }),
    ]);
    const registry = new FanOutRegistry();
    registry.register({ capabilityTag: "research", count: 3 });
    const tool: Tool = makeTaskTool({ submitter: counter.submitter, fanOutRegistry: registry });
    const result = await tool.execute(baseArgs, makeCtx());
    // Read via the holder (destructuring `callCount` would
    // snapshot the value at destructuring time, which is 0).
    expect(counter.callCount).toBe(3);
    // The model sees ONE aggregated result with 3 sub-agents' content.
    const content = (result as { content: SubagentResult }).content;
    expect(content.status).toBe("completed");
    expect(content.content).toHaveLength(6); // 3 headers + 3 text blocks
  });

  it("partition function injects i into each sub-agent's input", async () => {
    const seen: number[] = [];
    const submitter: MeshSubmitter = {
      async submit(input, _signal) {
        seen.push((input as { _i?: number })._i ?? -1);
        return makeResult({ text: `i=${(input as { _i?: number })._i ?? "?"}` });
      },
    };
    const registry = new FanOutRegistry();
    registry.register({
      capabilityTag: "research",
      count: 3,
      partition: (input, i, _count) => ({ ...input, objective: `i-${i}-${input.objective}`, _i: i }) as never,
    });
    const tool = makeTaskTool({ submitter, fanOutRegistry: registry });
    await tool.execute(baseArgs, makeCtx());
    expect(seen).toEqual([0, 1, 2]);
  });

  it("identity partition (no partition function) → each sub-agent gets the same input", async () => {
    let callCount = 0;
    const submitter: MeshSubmitter = {
      async submit(_input, _signal) {
        callCount++;
        return makeResult({ text: `call-${callCount}` });
      },
    };
    const registry = new FanOutRegistry();
    registry.register({ capabilityTag: "research", count: 3 });
    const tool = makeTaskTool({ submitter, fanOutRegistry: registry });
    await tool.execute(baseArgs, makeCtx());
    expect(callCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 10. task tool with NO registry: F10.1 + F10.2 baseline
// ---------------------------------------------------------------------------

describe("F10.4.1: task tool without FanOutRegistry (backward compat)", () => {
  it("ONE model call → ONE sub-agent (F10.1 baseline)", async () => {
    let callCount = 0;
    const submitter: MeshSubmitter = {
      async submit(_input, _signal) {
        callCount++;
        return makeResult({ text: "single" });
      },
    };
    // Pass MeshSubmitter directly (the F10.1.3 API; F10.4.1 also
    // accepts this shape for backward compat).
    const tool: Tool = makeTaskTool(submitter);
    const result = await tool.execute(baseArgs, makeCtx());
    expect(callCount).toBe(1);
    const content = (result as { content: SubagentResult }).content;
    expect(content.content[0]).toEqual({ type: "text", text: "single" });
  });

  it("MeshSubmitter passed directly (not wrapped in options) still works", async () => {
    const submitter: MeshSubmitter = {
      async submit(_input, _signal) {
        return makeResult({ text: "ok" });
      },
    };
    const tool = makeTaskTool(submitter);
    const result = await tool.execute(baseArgs, makeCtx());
    expect(result).toBeDefined();
  });
});
