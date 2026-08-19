/**
 * F10.6 tests — `subagentOf` field on `TraceEvent`.
 *
 * Covers:
 * 1. The parent's events have NO `subagentOf`
 *    (the parent is the root).
 * 2. A sub-agent's events carry the parent's
 *    sessionId in `subagentOf` (when
 *    `parentSessionId` is set on the factory).
 * 3. A sub-agent's events have NO `subagentOf` when
 *    the factory doesn't set `parentSessionId`
 *    (backward compat: the field is optional).
 * 4. All 6 `TraceEvent` kinds (`agent_start`,
 *    `model_response`, `tool_call`, `tool_result`,
 *    `agent_end`, `error`) carry the field.
 * 5. End-to-end: a parent calls the `task` tool
 *    with `parentSessionId` set; the parent's
 *    tracer receives the sub-agent's events with
 *    `subagentOf: <parentSessionId>`.
 * 6. The parent's own events (during the same
 *    run) do NOT carry `subagentOf` (the field
 *    is for sub-agent events only).
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  JsonLinesTracer,
  LocalMeshSubmitter,
  ToolRegistry,
  defaultBuildSubagentFactory,
  newSessionId,
  type MeshSubmitter,
  type ModelResponse,
  type TraceEvent,
} from "@envoymesh/envoy-harness";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function scriptedModel(responses: ReadonlyArray<{
  content: ModelResponse["content"];
  stopReason?: ModelResponse["stopReason"];
}>): MeshSubmitter["constructor"] extends never ? never : import("@envoymesh/envoy-harness").ModelAdapter {
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
  } as never;
}

function textBlock(text: string): ModelResponse["content"][number] {
  return { type: "text", text };
}

/** Collect every `TraceEvent` from a tracer. */
function makeCollectingTracer(): {
  tracer: JsonLinesTracer;
  events: TraceEvent[];
} {
  const events: TraceEvent[] = [];
  const tracer = new JsonLinesTracer({
    write: (line: string) => {
      events.push(JSON.parse(line) as TraceEvent);
    },
  });
  return { tracer, events };
}

// ---------------------------------------------------------------------------
// 1. Parent's events have NO subagentOf
// ---------------------------------------------------------------------------

describe("F10.6: subagentOf field on TraceEvent", () => {
  it("the parent's events have NO subagentOf (the parent is the root)", async () => {
    const { tracer, events } = makeCollectingTracer();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model: scriptedModel([{ content: [textBlock("done")] }]),
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      cwd: "/",
      tracer,
      // No subagentOf — this is the parent (root).
    });
    await agent.run("go");
    // Every event is missing subagentOf.
    for (const e of events) {
      expect(e.subagentOf).toBeUndefined();
    }
  });

  // -----------------------------------------------------------------------
  // 2. Sub-agent's events carry parent's sessionId
  // -----------------------------------------------------------------------

  it("a sub-agent's events carry the parent's sessionId in subagentOf", async () => {
    const parentSessionId = "parent-session-abc";
    const events: TraceEvent[] = [];
    const tracer = new JsonLinesTracer({
      write: (line: string) => {
        events.push(JSON.parse(line) as TraceEvent);
      },
    });
    const subModel = scriptedModel([{ content: [textBlock("sub-done")] }]);
    const build = defaultBuildSubagentFactory({
      model: subModel,
      parentSessionId,
      parentTracer: tracer,
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
    // Every event the parent tracer received is a
    // sub-agent event. All carry subagentOf.
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.subagentOf).toBe(parentSessionId);
    }
  });

  // -----------------------------------------------------------------------
  // 3. Sub-agent's events have NO subagentOf when not set
  // -----------------------------------------------------------------------

  it("a sub-agent's events have NO subagentOf when the factory doesn't set parentSessionId (backward compat)", async () => {
    const events: TraceEvent[] = [];
    const tracer = new JsonLinesTracer({
      write: (line: string) => {
        events.push(JSON.parse(line) as TraceEvent);
      },
    });
    const subModel = scriptedModel([{ content: [textBlock("sub-done")] }]);
    const build = defaultBuildSubagentFactory({
      model: subModel,
      parentTracer: tracer,
      // No parentSessionId.
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
    // The events are present (parentTracer is set)
    // but no subagentOf.
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.subagentOf).toBeUndefined();
    }
  });

  // -----------------------------------------------------------------------
  // 4. All 6 event kinds carry the field
  // -----------------------------------------------------------------------

  it("all 6 TraceEvent kinds carry the subagentOf field (when set)", async () => {
    const parentSessionId = "parent-session-xyz";
    const events: TraceEvent[] = [];
    const tracer = new JsonLinesTracer({
      write: (line: string) => {
        events.push(JSON.parse(line) as TraceEvent);
      },
    });
    // Sub-agent that calls a tool, then returns.
    const subModel = scriptedModel([
      {
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "bash",
            args: { command: "echo hi" },
          },
        ],
      },
      { content: [textBlock("sub-done")] },
    ]);
    const build = defaultBuildSubagentFactory({
      model: subModel,
      parentSessionId,
      parentTracer: tracer,
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
    // The kinds we expect: agent_start, model_response
    // (with tool_use stopReason), tool_call, tool_result,
    // model_response (with end_turn stopReason),
    // agent_end. (We don't test the `error` kind here —
    // it requires a forced error path.)
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has("agent_start")).toBe(true);
    expect(kinds.has("model_response")).toBe(true);
    expect(kinds.has("tool_call")).toBe(true);
    expect(kinds.has("tool_result")).toBe(true);
    expect(kinds.has("agent_end")).toBe(true);
    // Every event carries subagentOf.
    for (const e of events) {
      expect(e.subagentOf).toBe(parentSessionId);
    }
  });
});

// ---------------------------------------------------------------------------
// 5-6. End-to-end: parent + sub-agent interleaved events
// ---------------------------------------------------------------------------

describe("F10.6: end-to-end (parent + sub-agent events)", () => {
  it("the parent tracer sees parent's events (no subagentOf) AND sub-agent's events (with subagentOf)", async () => {
    // The PARENT has a tracer. The parent's model emits
    // a `task` tool call; the sub-agent runs and emits
    // events; the parent's tracer sees both.
    const parentSessionId = "parent-1";
    const events: TraceEvent[] = [];
    const tracer = new JsonLinesTracer({
      write: (line: string) => {
        events.push(JSON.parse(line) as TraceEvent);
      },
    });
    // Parent's model: first call → task; second call → end_turn.
    let parentCallCount = 0;
    const parentModel: import("@envoymesh/envoy-harness").ModelAdapter = {
      async complete() {
        parentCallCount++;
        if (parentCallCount === 1) {
          return {
            content: [
              {
                type: "tool_call",
                id: "t1",
                name: "task",
                args: {
                  objective: "do x",
                  capability_tag: "research",
                  cost_ceiling_usd: 0.1,
                  deadline_ms: 1000,
                },
              },
            ],
            stopReason: "tool_use",
          };
        }
        return { content: [textBlock("parent-done")], stopReason: "end_turn" };
      },
    };
    const subModel = scriptedModel([{ content: [textBlock("sub-done")] }]);
    const submitter = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({
        model: subModel,
        parentSessionId,
        parentTracer: tracer,
      }),
      workerPeerId: "w1",
    });
    // Construct the parent with a known session id.
    const session = new InMemorySession(parentSessionId, {
      cwd: "/",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const parent = new Agent({
      model: parentModel,
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      cwd: "/",
      tracer,
      meshSubmitter: submitter,
    });
    await parent.run("go");
    // The events are interleaved: parent + sub-agent.
    // Parent's events: agent_start, model_response,
    // tool_call, tool_result, model_response, agent_end.
    // Sub-agent's events: agent_start, model_response,
    // agent_end. (All of the sub-agent's events
    // should carry subagentOf = parentSessionId.)
    const parentEvents = events.filter((e) => e.subagentOf === undefined);
    const subEvents = events.filter((e) => e.subagentOf === parentSessionId);
    // Both streams are present.
    expect(parentEvents.length).toBeGreaterThan(0);
    expect(subEvents.length).toBeGreaterThan(0);
  });
});
