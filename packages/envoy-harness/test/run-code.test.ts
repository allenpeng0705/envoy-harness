/**
 * Gap 6 — run_code PTC MVP.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  ToolRegistry,
  makeRunCodeTool,
  newSessionId,
  type ModelAdapter,
  type ModelResponse,
  type ToolContext,
} from "../src/index.js";

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

describe("makeRunCodeTool", () => {
  it("invokes registered tools via tools.invoke", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute(args) {
        return { content: String((args as { text: string }).text) };
      },
    });
    const runCode = makeRunCodeTool({ tools });
    tools.register(runCode);
    const res = await runCode.execute(
      {
        code: `const a = await tools.invoke("echo", { text: "hi" }); return a;`,
      },
      makeCtx(),
    );
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(String(res.content)) as {
      ok: boolean;
      returnValue: string;
      invokes: unknown[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.returnValue).toBe("hi");
    expect(parsed.invokes).toHaveLength(1);
  });

  it("refuses require / process", async () => {
    const tools = new ToolRegistry();
    const runCode = makeRunCodeTool({ tools });
    const res = await runCode.execute(
      { code: `return require("fs");` },
      makeCtx(),
    );
    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/require|not defined|error/i);
  });

  it("stops further invokes when work_budget is exhausted mid-script", async () => {
    const tools = new ToolRegistry();
    let n = 0;
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute(args) {
        n += 1;
        return { content: String((args as { text: string }).text) };
      },
    });
    let remaining = 1;
    const runCode = makeRunCodeTool({
      tools,
      tryConsumeWorkBudget: () => {
        if (remaining <= 0) return false;
        remaining -= 1;
        return true;
      },
    });
    const res = await runCode.execute(
      {
        code: `
          await tools.invoke("echo", { text: "one" });
          await tools.invoke("echo", { text: "two" });
          return "ok";
        `,
      },
      makeCtx(),
    );
    expect(res.isError).toBe(true);
    expect(n).toBe(1);
    expect(String(res.content)).toMatch(/work_budget exhausted/);
  });

  it("Agent.run executes run_code from a scripted model", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute(args) {
        return { content: String((args as { text: string }).text) };
      },
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
                name: "run_code",
                args: {
                  code: `return await tools.invoke("echo", { text: "loop" });`,
                },
              },
            ],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
      },
    };
    const agent = new Agent({
      model,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      enableRunCode: true,
    });
    await agent.run("go");
    const toolMsg = agent.session.messages.find((m) => m.role === "tool");
    expect(JSON.stringify(toolMsg)).toContain("loop");
  });

  it("overlaps concurrency-safe invokes up to maxParallelSubCalls", async () => {
    const tools = new ToolRegistry();
    let peak = 0;
    let inFlight = 0;
    tools.register({
      name: "slow_echo",
      description: "slow",
      parameters: z.object({ text: z.string() }),
      isConcurrencySafe: () => true,
      async execute(args) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 40));
        inFlight -= 1;
        return { content: String((args as { text: string }).text) };
      },
    });
    const runCode = makeRunCodeTool({
      tools,
      maxParallelSubCalls: 3,
      timeoutMs: 5_000,
      maxInvokes: 32,
    });
    const res = await runCode.execute(
      {
        code: `
          const ps = [1,2,3,4,5].map((n) => tools.invoke("slow_echo", { text: String(n) }));
          return (await Promise.all(ps)).join(",");
        `,
      },
      makeCtx(),
    );
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(String(res.content)) as {
      ok: boolean;
      returnValue: string;
      invokes: Array<{ id: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.returnValue).toBe("1,2,3,4,5");
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(parsed.invokes.every((i) => /:ptc:\d+$/.test(i.id))).toBe(true);
  });

  it("runs exclusive tools as barriers (no overlap with others)", async () => {
    const tools = new ToolRegistry();
    const timeline: string[] = [];
    tools.register({
      name: "safe",
      description: "safe",
      parameters: z.object({ n: z.number() }),
      isConcurrencySafe: () => true,
      async execute(args) {
        timeline.push(`safe-start-${(args as { n: number }).n}`);
        await new Promise((r) => setTimeout(r, 30));
        timeline.push(`safe-end-${(args as { n: number }).n}`);
        return { content: "ok" };
      },
    });
    tools.register({
      name: "exclusive",
      description: "exclusive",
      parameters: z.object({}),
      async execute() {
        timeline.push("ex-start");
        await new Promise((r) => setTimeout(r, 20));
        timeline.push("ex-end");
        return { content: "x" };
      },
    });
    const runCode = makeRunCodeTool({
      tools,
      maxParallelSubCalls: 4,
      timeoutMs: 5_000,
      maxInvokes: 32,
    });
    const res = await runCode.execute(
      {
        code: `
          const a = tools.invoke("safe", { n: 1 });
          const b = tools.invoke("exclusive", {});
          const c = tools.invoke("safe", { n: 2 });
          await Promise.all([a, b, c]);
          return "done";
        `,
      },
      makeCtx(),
    );
    expect(res.isError).toBeUndefined();
    const exStart = timeline.indexOf("ex-start");
    const exEnd = timeline.indexOf("ex-end");
    expect(exStart).toBeGreaterThanOrEqual(0);
    for (let i = exStart; i <= exEnd; i++) {
      expect(timeline[i]).not.toMatch(/^safe-/);
    }
  });

  it("terminates when maxInvokes allowance is exceeded", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      isConcurrencySafe: () => true,
      async execute(args) {
        return { content: String((args as { text: string }).text) };
      },
    });
    const runCode = makeRunCodeTool({
      tools,
      maxInvokes: 2,
      timeoutMs: 5_000,
    });
    const res = await runCode.execute(
      {
        code: `
          await tools.invoke("echo", { text: "a" });
          await tools.invoke("echo", { text: "b" });
          await tools.invoke("echo", { text: "c" });
          return "nope";
        `,
      },
      makeCtx(),
    );
    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/maxInvokes/);
    expect(res.meta?.ptc?.maxInvokes).toBe(2);
  });

  it("Agent registers run_code when enableRunCode is true", () => {
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
      enableRunCode: true,
    });
    expect(agent.tools.get("run_code")).toBeDefined();
  });
});
