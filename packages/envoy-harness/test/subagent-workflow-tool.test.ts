/**
 * Gap 4 — model-facing `workflow` tool (parallel / pipeline).
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  ToolRegistry,
  makeWorkflowTool,
  newSessionId,
  type MeshSubmitter,
  type ModelAdapter,
  type ModelResponse,
  type SubagentInput,
  type SubagentResult,
  type ToolContext,
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

function makeCtx(): ToolContext {
  return {
    cwd: "/tmp",
    session: new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    }),
    abortSignal: new AbortController().signal,
  };
}

const task = (objective: string) => ({
  objective,
  capability_tag: "test",
  cost_ceiling_usd: 1,
  deadline_ms: 5_000,
});

describe("makeWorkflowTool", () => {
  it("mode=parallel fans out and returns aggregated JSON", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const submitter = scriptedSubmitter(async (input) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return okResult(`done:${input.objective}`);
    });
    const tool = makeWorkflowTool({ submitter });
    const res = await tool.execute(
      {
        mode: "parallel",
        tasks: [task("a"), task("b"), task("c")],
      },
      makeCtx(),
    );
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(String(res.content)) as {
      mode: string;
      results: Array<{ text: string }>;
      aggregated: { status: string };
    };
    expect(parsed.mode).toBe("parallel");
    expect(parsed.results).toHaveLength(3);
    expect(parsed.aggregated.status).toBe("completed");
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it("mode=pipeline feeds prior step text into the next objective", async () => {
    const objectives: string[] = [];
    const submitter = scriptedSubmitter((input) => {
      objectives.push(input.objective);
      return okResult(`out-${objectives.length}`);
    });
    const tool = makeWorkflowTool({ submitter });
    const res = await tool.execute(
      {
        mode: "pipeline",
        tasks: [task("step-1"), task("step-2")],
      },
      makeCtx(),
    );
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(String(res.content)) as {
      mode: string;
      final: { text: string };
    };
    expect(parsed.mode).toBe("pipeline");
    expect(objectives[0]).toBe("step-1");
    expect(objectives[1]).toContain("step-2");
    expect(objectives[1]).toContain("out-1");
    expect(parsed.final.text).toContain("out-2");
  });

  it("pipeline failed step sets isError through Agent.run", async () => {
    let calls = 0;
    const submitter = scriptedSubmitter(() => {
      calls += 1;
      if (calls === 1) {
        return okResult("step1-ok");
      }
      return okResult("boom", { status: "failed" });
    });
    let i = 0;
    const model: ModelAdapter = {
      async complete() {
        i += 1;
        if (i === 1) {
          return {
            content: [
              {
                type: "tool_call",
                id: "1",
                name: "workflow",
                args: {
                  mode: "pipeline",
                  tasks: [task("step-1"), task("step-2")],
                },
              },
            ],
            stopReason: "tool_use",
          };
        }
        return {
          content: [{ type: "text", text: "after fail" }],
          stopReason: "end_turn",
        };
      },
    };
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      meshSubmitter: submitter,
    });
    await agent.run("pipeline fail");
    const toolMsg = agent.session.messages.find((m) => m.role === "tool");
    const block = toolMsg?.content.find((b) => b.type === "tool_result");
    expect(block && block.type === "tool_result" && block.isError).toBe(true);
    const raw =
      block && block.type === "tool_result"
        ? typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content)
        : "";
    expect(raw).toContain('"mode":"pipeline"');
    expect(raw).toContain('"status":"failed"');
    // First step ran; second failed — pipeline stops early (2 submits).
    expect(calls).toBe(2);
  });

  it("surfaces maxSubagents refusal as isError", async () => {
    const submitter = scriptedSubmitter(() => okResult("x"));
    const tool = makeWorkflowTool({ submitter, maxSubagents: 1 });
    const res = await tool.execute(
      {
        mode: "parallel",
        tasks: [task("a"), task("b")],
      },
      makeCtx(),
    );
    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/maxSubagents/);
  });

  it("Agent registers workflow when meshSubmitter is set", () => {
    const model: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
      },
    };
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      meshSubmitter: scriptedSubmitter(() => okResult("x")),
    });
    expect(agent.tools.get("workflow")).toBeDefined();
  });
});
