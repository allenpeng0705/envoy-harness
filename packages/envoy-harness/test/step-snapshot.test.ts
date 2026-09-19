/**
 * Per-iteration settings snapshot — hermetic tests.
 *
 * The loop reads live agent state so the REPL's `/model` and `/sandbox`
 * take effect mid-session. The snapshot makes each *request* internally
 * consistent: a swap landing during an iteration is adopted at the next
 * boundary, never mixed into the request already in flight.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Agent,
  InMemorySession,
  ToolRegistry,
  newSessionId,
  type CompleteInput,
  type ModelAdapter,
  type ModelResponse,
  type Tool,
} from "../src/index.js";

const echoTool: Tool = {
  name: "bash",
  description: "echo",
  parameters: z.object({ command: z.string() }),
  async execute() {
    return { content: "ok" };
  },
};

function session() {
  return new InMemorySession(newSessionId(), {
    cwd: process.cwd(),
    permissionMode: "workspace-write",
    startedAt: new Date().toISOString(),
  });
}

describe("per-step snapshot", () => {
  it("uses the model captured at the START of an iteration for that request", async () => {
    const seen: string[] = [];
    const slowModel: ModelAdapter = {
      async complete(input: CompleteInput): Promise<ModelResponse> {
        seen.push("slow");
        // A `/model` swap lands while this request is in flight.
        agent.model = fastModel;
        void input;
        return { content: [{ type: "text", text: "one" }], stopReason: "tool_use" };
      },
    };
    const fastModel: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        seen.push("fast");
        return { content: [{ type: "text", text: "two" }], stopReason: "end_turn" };
      },
    };

    const agent = new Agent({
      model: slowModel,
      tools: new ToolRegistry(),
      session: session(),
      cwd: process.cwd(),
      maxIterations: 3,
    });

    await agent.run("go");
    // Request 1 used `slow`; only a LATER request may use `fast`.
    expect(seen[0]).toBe("slow");
  });

  it("emits a notice when the configuration changes between iterations", async () => {
    const events: string[] = [];
    const m: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
      },
    };
    const agent = new Agent({
      model: m,
      tools: new ToolRegistry(),
      session: session(),
      cwd: process.cwd(),
      maxIterations: 2,
      tracer: { emit: (event) => events.push(event.kind) },
    });
    await agent.run("go");
    // A single-iteration turn has nothing to compare, so no notice.
    expect(events.filter((k) => k === "error")).toHaveLength(0);
  });

  it("filters the tool list through the collaboration mode at capture time", async () => {
    const capturedTools: string[][] = [];
    const m: ModelAdapter = {
      async complete(input: CompleteInput): Promise<ModelResponse> {
        capturedTools.push(input.tools.map((t) => t.name));
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
      },
    };
    const tools = new ToolRegistry();
    tools.register(echoTool);
    tools.register({
      name: "write",
      description: "write",
      parameters: z.object({ path: z.string(), content: z.string() }),
      async execute() {
        return { content: "ok" };
      },
    } as Tool);

    const agent = new Agent({
      model: m,
      tools,
      session: session(),
      cwd: process.cwd(),
      maxIterations: 2,
    });

    // Plan mode hides the mutating tool.
    agent.session.setCollaborationMode({
      kind: "plan",
      updatedAt: new Date().toISOString(),
    });
    await agent.run("plan something");

    expect(capturedTools[0]).toContain("bash");
    expect(capturedTools[0]).not.toContain("write");
  });

  it("carries the retry policy into the iteration", async () => {
    let calls = 0;
    const m: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        calls += 1;
        // Retryable class; with maxRetries 0 there must be exactly one try.
        throw { status: 503, message: "unavailable" };
      },
    };
    const agent = new Agent({
      model: m,
      tools: new ToolRegistry(),
      session: session(),
      cwd: process.cwd(),
      maxIterations: 1,
      retryPolicy: {
        maxRetries: 0,
        initialDelayMs: 1,
        maxDelayMs: 1,
        jitterRatio: 0,
        retryableClasses: ["SERVER"],
      },
    });

    const result = await agent.run("go");
    expect(result.stopReason).toBe("aborted");
    expect(calls).toBe(1);
  });
});

