/**
 * F9.4.2 tests — `AgentOptions.tracer` + the 5 emit
 * points in the agent loop.
 *
 * Covers:
 * 1. `agent_start` is emitted at the start of `run()`
 *    with sessionId, model, cwd, tools.
 * 2. `model_response` is emitted after each model call
 *    with iteration, stopReason, content.
 * 3. `tool_call` is emitted before each tool's `execute`.
 * 4. `tool_result` is emitted after each tool's `execute`
 *    with durationMs and the result.
 * 5. `agent_end` is emitted at the end of `run()` with
 *    stopReason, iterations, toolCalls, metrics.
 * 6. `error` is emitted on model errors.
 * 7. Without `AgentOptions.tracer`, NullTracer is used
 *    (no observable side effect; all existing tests pass).
 * 8. The full event sequence is `agent_start`,
 *    [model_response, tool_call, tool_result]*,
 *    agent_end.
 * 9. `agent_end` is the last event the tracer sees.
 * 10. The tracer receives events in real-time (sync emit).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  JsonLinesTracer,
  newSessionId,
  type ModelAdapter,
  type ModelResponse,
  type Tool,
  type TraceEvent,
} from "@envoymesh/envoy-harness";
import { ToolRegistry } from "@envoymesh/envoy-harness";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

function scriptedModel(responses: ReadonlyArray<{
  content: ModelResponse["content"];
  stopReason?: ModelResponse["stopReason"];
}>): ModelAdapter {
  let i = 0;
  return {
    async complete() {
      const r = responses[i++];
      if (!r) throw new Error(`scriptedModel: exhausted (call #${i})`);
      return {
        content: r.content,
        stopReason: r.stopReason ?? (r.content.some((b) => b.type === "tool_call") ? "tool_use" : "end_turn"),
      };
    },
  };
}

function toolCallBlock(id: string, name: string, args: unknown): ModelResponse["content"][number] {
  return { type: "tool_call", id, name, args };
}

function textBlock(text: string): ModelResponse["content"][number] {
  return { type: "text", text };
}

function buildAgent(opts: {
  model: ModelAdapter;
  tracer?: import("@envoymesh/envoy-harness").Tracer;
  tool?: Tool;
  cwd?: string;
}) {
  const tools = new ToolRegistry();
  if (opts.tool) tools.register(opts.tool);
  const cwd = opts.cwd ?? "/";
  const session = new InMemorySession(newSessionId(), {
    cwd,
    permissionMode: "read-only",
    startedAt: new Date().toISOString(),
  });
  const agent = new Agent({
    model: opts.model,
    tools,
    session,
    hooks: new HookRegistry(),
    cwd,
    ...(opts.tracer ? { tracer: opts.tracer } : {}),
  });
  return { agent, session, tools };
}

function parseTrace(stream: MemoryStream): TraceEvent[] {
  return stream.chunks
    .join("")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TraceEvent);
}

// ---------------------------------------------------------------------------
// 1. agent_start
// ---------------------------------------------------------------------------

describe("agent_start event", () => {
  it("is emitted at the start of run() with sessionId, model, cwd, tools", async () => {
    const stream = new MemoryStream();
    const tracer = new JsonLinesTracer(stream);
    const { agent } = buildAgent({
      model: scriptedModel([{ content: [textBlock("hi")] }]),
      tracer,
    });
    await agent.run("hello");
    const events = parseTrace(stream);
    const start = events.find((e) => e.kind === "agent_start");
    expect(start).toBeDefined();
    if (start?.kind !== "agent_start") return;
    expect(start.sessionId).toBeTruthy();
    expect(start.cwd).toBe("/");
    expect(start.tools).toEqual([]);
  });

  it("includes the registered tool names in `tools`", async () => {
    const stream = new MemoryStream();
    const tracer = new JsonLinesTracer(stream);
    const echoTool: Tool = {
      name: "echo",
      description: "echo",
      parameters: z.object({ s: z.string() }),
      async execute({ s }) {
        return { content: s };
      },
    };
    const { agent } = buildAgent({
      model: scriptedModel([
        { content: [toolCallBlock("t1", "echo", { s: "x" })] },
        { content: [textBlock("done")] },
      ]),
      tracer,
      tool: echoTool,
    });
    await agent.run("run echo");
    const events = parseTrace(stream);
    const start = events.find((e) => e.kind === "agent_start");
    if (start?.kind !== "agent_start") return;
    expect(start.tools).toEqual(["echo"]);
  });
});

// ---------------------------------------------------------------------------
// 2. model_response
// ---------------------------------------------------------------------------

describe("model_response event", () => {
  it("is emitted after each model call with iteration, stopReason, content", async () => {
    const stream = new MemoryStream();
    const tracer = new JsonLinesTracer(stream);
    const echoTool: Tool = {
      name: "echo",
      description: "echo",
      parameters: z.object({ s: z.string() }),
      async execute({ s }) {
        return { content: s };
      },
    };
    // 1st call: model emits a tool_call. 2nd call:
    // model emits text (the loop runs again to read
    // the tool result). 2 model_response events.
    const { agent } = buildAgent({
      model: scriptedModel([
        { content: [toolCallBlock("t1", "echo", { s: "x" })] },
        { content: [textBlock("done")] },
      ]),
      tracer,
      tool: echoTool,
    });
    await agent.run("run echo");
    const events = parseTrace(stream);
    const responses = events.filter((e) => e.kind === "model_response");
    expect(responses).toHaveLength(2);
    if (responses[0]?.kind !== "model_response") return;
    expect(responses[0].iteration).toBe(1);
    expect(responses[0].stopReason).toBe("tool_use");
    expect(responses[1]?.kind === "model_response" && responses[1].iteration).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. tool_call + 4. tool_result
// ---------------------------------------------------------------------------

describe("tool_call + tool_result events", () => {
  it("emit around each tool execution", async () => {
    const stream = new MemoryStream();
    const tracer = new JsonLinesTracer(stream);
    const echoTool: Tool = {
      name: "echo",
      description: "echo",
      parameters: z.object({ s: z.string() }),
      async execute({ s }) {
        return { content: s };
      },
    };
    const { agent } = buildAgent({
      model: scriptedModel([
        { content: [toolCallBlock("t1", "echo", { s: "x" })] },
        { content: [textBlock("done")] },
      ]),
      tracer,
      tool: echoTool,
    });
    await agent.run("run echo");
    const events = parseTrace(stream);
    const calls = events.filter((e) => e.kind === "tool_call");
    const results = events.filter((e) => e.kind === "tool_result");
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    if (calls[0]?.kind !== "tool_call") return;
    expect(calls[0].call).toEqual({
      type: "tool_call",
      id: "t1",
      name: "echo",
      args: { s: "x" },
    });
    if (results[0]?.kind !== "tool_result") return;
    expect(results[0].callId).toBe("t1");
    expect(results[0].result).toEqual({ content: "x" });
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("tool_result preserves isError when the tool fails", async () => {
    const stream = new MemoryStream();
    const tracer = new JsonLinesTracer(stream);
    const failTool: Tool = {
      name: "fail",
      description: "always fails",
      parameters: z.object({}),
      async execute() {
        return { content: "boom", isError: true };
      },
    };
    const { agent } = buildAgent({
      model: scriptedModel([
        { content: [toolCallBlock("t1", "fail", {})] },
        { content: [textBlock("done")] },
      ]),
      tracer,
      tool: failTool,
    });
    await agent.run("run fail");
    const events = parseTrace(stream);
    const result = events.find((e) => e.kind === "tool_result");
    if (result?.kind !== "tool_result") return;
    expect(result.result).toEqual({ content: "boom", isError: true });
  });
});

// ---------------------------------------------------------------------------
// 5. agent_end
// ---------------------------------------------------------------------------

describe("agent_end event", () => {
  it("is emitted at the end of run() with stopReason, iterations, toolCalls, metrics", async () => {
    const stream = new MemoryStream();
    const tracer = new JsonLinesTracer(stream);
    const { agent } = buildAgent({
      model: scriptedModel([{ content: [textBlock("hi")] }]),
      tracer,
    });
    await agent.run("hi");
    const events = parseTrace(stream);
    const end = events[events.length - 1];
    expect(end?.kind).toBe("agent_end");
    if (end?.kind !== "agent_end") return;
    expect(end.stopReason).toBe("end_turn");
    expect(end.iterations).toBe(1);
    expect(end.toolCalls).toBe(0);
    expect(end.metrics).toBeDefined();
  });

  it("is the last event the tracer sees", async () => {
    const stream = new MemoryStream();
    const tracer = new JsonLinesTracer(stream);
    const echoTool: Tool = {
      name: "echo",
      description: "echo",
      parameters: z.object({ s: z.string() }),
      async execute({ s }) {
        return { content: s };
      },
    };
    const { agent } = buildAgent({
      model: scriptedModel([
        { content: [toolCallBlock("t1", "echo", { s: "x" })] },
        { content: [textBlock("done")] },
      ]),
      tracer,
      tool: echoTool,
    });
    await agent.run("run echo");
    const events = parseTrace(stream);
    expect(events[events.length - 1]?.kind).toBe("agent_end");
  });
});

// ---------------------------------------------------------------------------
// 6. error event
// ---------------------------------------------------------------------------

describe("error event", () => {
  it("is emitted on model errors", async () => {
    const stream = new MemoryStream();
    const tracer = new JsonLinesTracer(stream);
    const failingModel: ModelAdapter = {
      async complete() {
        throw new Error("rate limit");
      },
    };
    const { agent } = buildAgent({ model: failingModel, tracer });
    await agent.run("hi");
    const events = parseTrace(stream);
    const errorEvent = events.find((e) => e.kind === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.kind !== "error") return;
    expect(errorEvent.message).toMatch(/rate limit/);
  });
});

// ---------------------------------------------------------------------------
// 7. Default (no tracer)
// ---------------------------------------------------------------------------

describe("Agent without tracer option", () => {
  it("uses NullTracer; no observable side effect", async () => {
    const { agent } = buildAgent({
      model: scriptedModel([{ content: [textBlock("hi")] }]),
    });
    const result = await agent.run("hi");
    expect(result.stopReason).toBe("end_turn");
  });
});

// ---------------------------------------------------------------------------
// 8. Full event sequence
// ---------------------------------------------------------------------------

describe("full event sequence", () => {
  it("is agent_start → (model_response, tool_call, tool_result)* → agent_end", async () => {
    const stream = new MemoryStream();
    const tracer = new JsonLinesTracer(stream);
    const echoTool: Tool = {
      name: "echo",
      description: "echo",
      parameters: z.object({ s: z.string() }),
      async execute({ s }) {
        return { content: s };
      },
    };
    const { agent } = buildAgent({
      model: scriptedModel([
        {
          content: [
            textBlock("calling echo"),
            toolCallBlock("t1", "echo", { s: "x" }),
          ],
        },
        { content: [textBlock("done")] },
      ]),
      tracer,
      tool: echoTool,
    });
    await agent.run("run echo");
    const events = parseTrace(stream);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "agent_start",
      "model_response",
      "tool_call",
      "tool_result",
      "model_response",
      "agent_end",
    ]);
  });
});
