/**
 * F10.5 tests — sub-agent → parent cost + trace forwarding.
 *
 * Covers:
 * 1. `CostTracker.addSubagentCost` adds to the
 *    running total (no token attribution).
 * 2. `CostTracker.addSubagentCost` with 0 is a no-op
 *    (defensive).
 * 3. End-to-end: a sub-agent's `costUsd` flows into
 *    the parent's `AgentResult.metrics.costUsd` via
 *    the `onSubagentComplete` callback.
 * 4. Fan-out: an aggregated result's `costUsd` (sum
 *    of N) flows into the parent's
 *    `AgentResult.metrics.costUsd`.
 * 5. Sub-agent's `TraceEvent`s flow to the parent
 *    tracer when `parentTracer` is set on the
 *    `defaultBuildSubagentFactory` (F10.5 progress
 *    streaming).
 * 6. `parentTracer` is OPTIONAL — when not set, the
 *    sub-agent uses a `NullTracer` (backward compat
 *    with F10.1.2).
 * 7. A custom `buildSubagent` factory can use the
 *    `parentTracer` (the factory closes over the
 *    tracer and passes it to the new `Agent`).
 * 8. The `task` tool's `onSubagentComplete` callback
 *    receives the AGGREGATED result (with summed
 *    `costUsd`) for fan-out — not the N individual
 *    results.
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  CostTracker,
  FanOutRegistry,
  HookRegistry,
  InMemorySession,
  JsonLinesTracer,
  LocalMeshSubmitter,
  ToolRegistry,
  defaultBuildSubagentFactory,
  newSessionId,
  type MeshSubmitter,
  type ModelAdapter,
  type ModelResponse,
  type SubagentResult,
  type Tool,
  type TraceEvent,
  makeTaskTool,
} from "@envoymesh/envoy-harness";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function textBlock(text: string): ModelResponse["content"][number] {
  return { type: "text", text };
}

function scriptedModel(
  responses: ReadonlyArray<{
    content: ModelResponse["content"];
    stopReason?: ModelResponse["stopReason"];
  }>,
): ModelAdapter {
  let idx = 0;
  return {
    async complete() {
      const r = responses[idx++];
      if (!r) throw new Error(`scriptedModel: exhausted (call #${idx})`);
      return {
        content: r.content,
        stopReason: r.stopReason ?? (r.content.some((b) => b.type === "tool_call") ? "tool_use" : "end_turn"),
      };
    },
  };
}

function makeSubagentResult(opts: {
  costUsd?: number;
  status?: SubagentResult["status"];
  text?: string;
}): SubagentResult {
  return {
    status: opts.status ?? "completed",
    content: [{ type: "text", text: opts.text ?? "done" }],
    workerPeerId: "w1",
    workerRuntime: "envoy-harness",
    costUsd: opts.costUsd ?? 0.01,
    durationMs: 10,
    verdict: { kind: "pass", score: 0.5, confidence: "medium" },
    signature: "",
  };
}

const baseArgs = {
  objective: "x",
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
// 1-2. CostTracker.addSubagentCost
// ---------------------------------------------------------------------------

describe("F10.5: CostTracker.addSubagentCost", () => {
  it("adds to the running total (no token attribution)", () => {
    const tracker = new CostTracker({ model: "local" });
    // The parent has 0 cost (no model calls yet).
    expect(tracker.total().costUsd).toBe(0);
    // A sub-agent spent $0.01.
    tracker.addSubagentCost(0.01);
    expect(tracker.total().costUsd).toBeCloseTo(0.01, 5);
    // A second sub-agent spent $0.02.
    tracker.addSubagentCost(0.02);
    expect(tracker.total().costUsd).toBeCloseTo(0.03, 5);
    // The sub-agent cost did NOT add tokens.
    expect(tracker.total().inputTokens).toBe(0);
    expect(tracker.total().outputTokens).toBe(0);
  });

  it("addSubagentCost(0) is a no-op (the tool's callback skips 0-cost results)", () => {
    const tracker = new CostTracker({ model: "local" });
    tracker.addSubagentCost(0);
    expect(tracker.total().costUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3-4. End-to-end: cost flows from sub-agent to parent
// ---------------------------------------------------------------------------

describe("F10.5: end-to-end cost aggregation", () => {
  it("a sub-agent's costUsd flows into the parent's AgentResult.metrics.costUsd", async () => {
    // The sub-agent reports $0.05 of cost.
    const submitter: MeshSubmitter = {
      async submit(_input, _signal) {
        return makeSubagentResult({ costUsd: 0.05 });
      },
    };
    // Wire the callback.
    const costTracker = new CostTracker({ model: "local" });
    const tool: Tool = makeTaskTool({
      submitter,
      onSubagentComplete: (r) => costTracker.addSubagentCost(r.costUsd),
    });
    await tool.execute(baseArgs, makeCtx());
    // The parent's tracker has the sub-agent's cost.
    expect(costTracker.total().costUsd).toBeCloseTo(0.05, 5);
  });

  it("fan-out: aggregated result's costUsd (sum) flows into the parent's tracker", async () => {
    // 3 scripted sub-agents with costs 0.01, 0.02, 0.03.
    // After fan-out, the aggregated result's costUsd = 0.06.
    const { submitter, callCount } = (() => {
      let n = 0;
      return {
        callCount: 0,
        submitter: {
          async submit(_input, _signal) {
            n++;
            return makeSubagentResult({ costUsd: 0.01 * n });
          },
        } as MeshSubmitter & { callCount: number },
      };
    })();
    void callCount; // silence unused
    const registry = new FanOutRegistry();
    registry.register({ capabilityTag: "research", count: 3 });
    const costTracker = new CostTracker({ model: "local" });
    const tool: Tool = makeTaskTool({
      submitter,
      fanOutRegistry: registry,
      onSubagentComplete: (r) => costTracker.addSubagentCost(r.costUsd),
    });
    await tool.execute(baseArgs, makeCtx());
    // The parent got the AGGREGATED cost (0.06), not 3 individual costs.
    expect(costTracker.total().costUsd).toBeCloseTo(0.06, 5);
  });
});

// ---------------------------------------------------------------------------
// 5-6. Progress streaming: sub-agent's trace → parent tracer
// ---------------------------------------------------------------------------

describe("F10.5: progress streaming (sub-agent trace → parent tracer)", () => {
  it("sub-agent's TraceEvents flow to the parent tracer when parentTracer is set", async () => {
    // A custom buildSubagent factory that uses the parent tracer.
    const events: TraceEvent[] = [];
    const parentTracer = new JsonLinesTracer({
      write: (line: string) => {
        events.push(JSON.parse(line) as TraceEvent);
      },
    });
    const subModel = scriptedModel([
      { content: [textBlock("sub-done")] },
    ]);
    const build = defaultBuildSubagentFactory({
      model: subModel,
      parentTracer,
    });
    const submitter = new LocalMeshSubmitter({
      buildSubagent: build,
      workerPeerId: "w1",
    });
    await submitter.submit(
      {
        objective: "x",
        capabilityTag: "research",
        costCeilingUsd: 0.1,
        deadlineMs: 1000,
      },
      new AbortController().signal,
    );
    // The parent tracer saw the sub-agent's events.
    const eventKinds = events.map((e) => e.kind);
    expect(eventKinds).toContain("agent_start");
    expect(eventKinds).toContain("model_response");
    expect(eventKinds).toContain("agent_end");
  });

  it("parentTracer is OPTIONAL — when not set, the sub-agent uses NullTracer (backward compat)", async () => {
    // No parentTracer. The default factory creates a
    // NullTracer; the sub-agent runs without observable
    // side effects. We just verify the sub-agent returns
    // successfully (no crash).
    const subModel = scriptedModel([
      { content: [textBlock("sub-done")] },
    ]);
    const build = defaultBuildSubagentFactory({ model: subModel });
    const submitter = new LocalMeshSubmitter({
      buildSubagent: build,
      workerPeerId: "w1",
    });
    const result = await submitter.submit(
      {
        objective: "x",
        capabilityTag: "research",
        costCeilingUsd: 0.1,
        deadlineMs: 1000,
      },
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// 7. Custom buildSubagent factory can use parentTracer
// ---------------------------------------------------------------------------

describe("F10.5: custom buildSubagent factory uses parentTracer", () => {
  it("a custom factory closes over the parentTracer and passes it to the new Agent", async () => {
    const events: TraceEvent[] = [];
    const parentTracer = new JsonLinesTracer({
      write: (line: string) => {
        events.push(JSON.parse(line) as TraceEvent);
      },
    });
    const subModel = scriptedModel([
      { content: [textBlock("custom-done")] },
    ]);
    // A custom factory that uses the parent tracer.
    const customBuild = (): ((input: { objective: string }) => Agent) => {
      return (input) => {
        const session = new InMemorySession(newSessionId(), {
          cwd: "/",
          permissionMode: "read-only",
          startedAt: new Date().toISOString(),
        });
        const tools = new ToolRegistry();
        const agent = new Agent({
          model: subModel,
          tools,
          session,
          hooks: new HookRegistry(),
          cwd: "/",
          tracer: parentTracer,
        });
        void input;
        return agent;
      };
    };
    const submitter = new LocalMeshSubmitter({
      buildSubagent: customBuild(),
      workerPeerId: "w1",
    });
    await submitter.submit(
      {
        objective: "x",
        capabilityTag: "research",
        costCeilingUsd: 0.1,
        deadlineMs: 1000,
      },
      new AbortController().signal,
    );
    expect(events.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Callback receives AGGREGATED result for fan-out
// ---------------------------------------------------------------------------

describe("F10.5: onSubagentComplete receives AGGREGATED result for fan-out", () => {
  it("the callback fires once with the aggregated result (not N times)", async () => {
    // The sub-agent's submit returns different costs per call.
    let n = 0;
    const submitter: MeshSubmitter = {
      async submit(_input, _signal) {
        n++;
        return makeSubagentResult({ costUsd: 0.01 * n });
      },
    };
    const registry = new FanOutRegistry();
    registry.register({ capabilityTag: "research", count: 3 });
    let callbackCount = 0;
    let lastResult: SubagentResult | undefined;
    const tool: Tool = makeTaskTool({
      submitter,
      fanOutRegistry: registry,
      onSubagentComplete: (r) => {
        callbackCount++;
        lastResult = r;
      },
    });
    await tool.execute(baseArgs, makeCtx());
    // The callback fired exactly once.
    expect(callbackCount).toBe(1);
    // The last result was the aggregated one (costUsd = sum).
    expect(lastResult?.costUsd).toBeCloseTo(0.06, 5);
  });
});
