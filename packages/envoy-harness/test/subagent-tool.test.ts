/**
 * F10.1.3 tests — the `task` tool +
 * `AgentOptions.meshSubmitter` integration.
 *
 * Covers:
 * 1. `makeTaskTool(submitter)` returns a `Tool` with
 *    name "task".
 * 2. The tool's `execute` calls the submitter and
 *    returns the result.
 * 3. The tool's `execute` forwards the parent's
 *    `abortSignal` to the submitter.
 * 4. `AgentOptions.meshSubmitter` registers the
 *    `task` tool in the agent's tool registry.
 * 5. Without `meshSubmitter`, no `task` tool is
 *    registered.
 * 6. The tool's `parameters` schema validates
 *    `objective`, `capability_tag`, `cost_ceiling_usd`,
 *    `deadline_ms`.
 * 7. The tool's `parameters` rejects missing or
 *    invalid values.
 * 8. The tool's `description` mentions the mesh
 *    / sub-agent semantics (so the model knows
 *    what to use it for).
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  NOOP_MESH_SUBMITTER_ERROR,
  NoopMeshSubmitter,
  TaskInputSchema,
  defaultBuildSubagentFactory,
  makeTaskTool,
  newSessionId,
  type ModelAdapter,
  type ModelResponse,
  type MeshSubmitter,
  type SubagentInput,
  type SubagentResult,
  type ToolContext,
} from "@envoymesh/envoy-harness";
import { ToolRegistry } from "@envoymesh/envoy-harness";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

function textBlock(text: string): ModelResponse["content"][number] {
  return { type: "text", text };
}

function captureSubmitter(capture: {
  input?: SubagentInput;
  signal?: AbortSignal;
}): MeshSubmitter & { calls: number } {
  const t: MeshSubmitter & { calls: number } = {
    calls: 0,
    async submit(input: SubagentInput, signal: AbortSignal) {
      t.calls++;
      capture.input = input;
      capture.signal = signal;
      return {
        status: "completed",
        content: [{ type: "text", text: "ok" }],
        workerPeerId: "p1",
        workerRuntime: "envoy-harness",
        costUsd: 0.01,
        durationMs: 100,
        verdict: { kind: "pass", score: 0.9, confidence: "high" },
        signature: "",
      };
    },
  };
  return t;
}

function makeToolContext(): ToolContext {
  return {
    cwd: "/",
    session: new InMemorySession(newSessionId(), {
      cwd: "/",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    }),
    abortSignal: new AbortController().signal,
  };
}

// ---------------------------------------------------------------------------
// 1 + 2. makeTaskTool
// ---------------------------------------------------------------------------

describe("makeTaskTool", () => {
  it("returns a tool named 'task'", () => {
    const tool = makeTaskTool(new NoopMeshSubmitter());
    expect(tool.name).toBe("task");
  });

  it("the tool's description mentions sub-agent + mesh semantics", () => {
    const tool = makeTaskTool(new NoopMeshSubmitter());
    expect(tool.description).toMatch(/sub-agent/i);
    expect(tool.description).toMatch(/mesh/i);
  });

  it("the tool's execute calls the submitter", async () => {
    const capture: { input?: SubagentInput; signal?: AbortSignal } = {};
    const submitter = captureSubmitter(capture);
    const tool = makeTaskTool(submitter);
    const ctx = makeToolContext();
    await tool.execute(
      {
        objective: "find foo",
        capability_tag: "code-search",
        cost_ceiling_usd: 0.5,
        deadline_ms: 30_000,
      },
      ctx,
    );
    expect(submitter.calls).toBe(1);
    expect(capture.input?.objective).toBe("find foo");
    expect(capture.input?.capabilityTag).toBe("code-search");
    expect(capture.input?.costCeilingUsd).toBe(0.5);
    expect(capture.input?.deadlineMs).toBe(30_000);
  });

  it("the tool's execute forwards the abortSignal to the submitter", async () => {
    const capture: { input?: SubagentInput; signal?: AbortSignal } = {};
    const submitter = captureSubmitter(capture);
    const tool = makeTaskTool(submitter);
    const ac = new AbortController();
    const ctx: ToolContext = {
      ...makeToolContext(),
      abortSignal: ac.signal,
    };
    await tool.execute(
      {
        objective: "x",
        capability_tag: "y",
        cost_ceiling_usd: 0.1,
        deadline_ms: 1000,
      },
      ctx,
    );
    expect(capture.signal).toBe(ac.signal);
  });

  it("the tool's execute returns the submitter's result", async () => {
    const submitter = captureSubmitter({});
    const tool = makeTaskTool(submitter);
    const result = await tool.execute(
      {
        objective: "x",
        capability_tag: "y",
        cost_ceiling_usd: 0.1,
        deadline_ms: 1000,
      },
      makeToolContext(),
    );
    const content = result.content as SubagentResult;
    expect(content.status).toBe("completed");
    expect(content.workerPeerId).toBe("p1");
    expect(content.costUsd).toBe(0.01);
  });

  it("the tool's execute propagates submitter errors as tool errors", async () => {
    const tool = makeTaskTool(new NoopMeshSubmitter());
    // NoopMeshSubmitter throws → the agent's
    // executeToolCall catches the throw and
    // returns isError: true. The tool's `execute`
    // here just throws; the agent loop converts.
    // We test the throw directly.
    await expect(
      tool.execute(
        {
          objective: "x",
          capability_tag: "y",
          cost_ceiling_usd: 0.1,
          deadline_ms: 1000,
        },
        makeToolContext(),
      ),
    ).rejects.toThrow(NOOP_MESH_SUBMITTER_ERROR);
  });
});

// ---------------------------------------------------------------------------
// 6 + 7. Parameters schema
// ---------------------------------------------------------------------------

describe("TaskInputSchema", () => {
  it("accepts the documented fields", () => {
    const parsed = TaskInputSchema.parse({
      objective: "x",
      capability_tag: "y",
      cost_ceiling_usd: 0.1,
      deadline_ms: 1000,
    });
    expect(parsed.objective).toBe("x");
    expect(parsed.capability_tag).toBe("y");
    expect(parsed.cost_ceiling_usd).toBe(0.1);
    expect(parsed.deadline_ms).toBe(1000);
  });

  it("rejects missing objective", () => {
    expect(() =>
      TaskInputSchema.parse({
        capability_tag: "y",
        cost_ceiling_usd: 0.1,
        deadline_ms: 1000,
      }),
    ).toThrow();
  });

  it("rejects negative cost_ceiling_usd", () => {
    expect(() =>
      TaskInputSchema.parse({
        objective: "x",
        capability_tag: "y",
        cost_ceiling_usd: -1,
        deadline_ms: 1000,
      }),
    ).toThrow();
  });

  it("rejects zero deadline_ms", () => {
    expect(() =>
      TaskInputSchema.parse({
        objective: "x",
        capability_tag: "y",
        cost_ceiling_usd: 0.1,
        deadline_ms: 0,
      }),
    ).toThrow();
  });

  it("accepts optional preferred_peer_id and preferred_runtime", () => {
    const parsed = TaskInputSchema.parse({
      objective: "x",
      capability_tag: "y",
      cost_ceiling_usd: 0.1,
      deadline_ms: 1000,
      preferred_peer_id: "peer-1",
      preferred_runtime: "envoy-harness",
    });
    expect(parsed.preferred_peer_id).toBe("peer-1");
    expect(parsed.preferred_runtime).toBe("envoy-harness");
  });
});

// ---------------------------------------------------------------------------
// 4 + 5. AgentOptions.meshSubmitter
// ---------------------------------------------------------------------------

describe("AgentOptions.meshSubmitter", () => {
  function buildAgent(opts: {
    meshSubmitter?: MeshSubmitter;
  }): { agent: Agent; tools: ToolRegistry } {
    const tools = new ToolRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model: scriptedModel([{ content: [textBlock("ok")] }]),
      tools,
      session,
      hooks: new HookRegistry(),
      ...(opts.meshSubmitter ? { meshSubmitter: opts.meshSubmitter } : {}),
    });
    return { agent, tools };
  }

  it("registers the 'task' tool when meshSubmitter is set", () => {
    const { tools } = buildAgent({
      meshSubmitter: new NoopMeshSubmitter(),
    });
    const names = new Set(tools.list().map((t) => t.name));
    expect(names.has("task")).toBe(true);
  });

  it("does NOT register the 'task' tool without meshSubmitter", () => {
    const { tools } = buildAgent({});
    const names = new Set(tools.list().map((t) => t.name));
    expect(names.has("task")).toBe(false);
  });

  it("the registered 'task' tool uses the configured submitter", async () => {
    const submitter = captureSubmitter({});
    const { tools } = buildAgent({ meshSubmitter: submitter });
    const taskTool = tools.list().find((t) => t.name === "task")!;
    expect(taskTool).toBeDefined();
    await taskTool.execute(
      {
        objective: "test",
        capability_tag: "test",
        cost_ceiling_usd: 0.1,
        deadline_ms: 1000,
      },
      makeToolContext(),
    );
    expect(submitter.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: end-to-end via defaultBuildSubagentFactory
// ---------------------------------------------------------------------------

describe("integration: makeTaskTool + defaultBuildSubagentFactory", () => {
  it("the task tool runs a real sub-agent via LocalMeshSubmitter", async () => {
    const model = scriptedModel([{ content: [textBlock("from sub-agent")] }]);
    const build = defaultBuildSubagentFactory({ model });
    const submitter = {
      async submit(input: SubagentInput, _signal: AbortSignal): Promise<SubagentResult> {
        const agent = build(input);
        const result = await agent.run(input.objective);
        return {
          status: "completed",
          content: result.content,
          workerPeerId: "p1",
          workerRuntime: "envoy-harness",
          costUsd: result.metrics.costUsd,
          durationMs: 100,
          verdict: { kind: "pass", score: 0.5, confidence: "medium" },
          signature: "",
        };
      },
    };
    const tool = makeTaskTool(submitter);
    const result = await tool.execute(
      {
        objective: "do the thing",
        capability_tag: "code-search",
        cost_ceiling_usd: 1.0,
        deadline_ms: 30_000,
      },
      makeToolContext(),
    );
    const content = result.content as SubagentResult;
    expect(content.status).toBe("completed");
    const text = content.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    expect(text).toContain("from sub-agent");
  });
});
