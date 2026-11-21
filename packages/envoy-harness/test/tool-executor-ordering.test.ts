/**
 * Tool-call ordering + UTF-8 output bounds.
 *
 * Two defects these lock down:
 *
 * 1. **Transcript determinism.** Parallel `task` fan-out used to append
 *    each `tool_result` at its own completion time, so the transcript
 *    order was completion order — different across runs for identical
 *    input. Results must commit in MODEL order.
 * 2. **UTF-8 safety.** Ad-hoc `slice`/`subarray` caps could split a
 *    surrogate pair or land mid-codepoint (U+FFFD).
 */

import { describe, expect, it } from "vitest";

import {
  InMemorySession,
  newSessionId,
  ToolExecutor,
  ToolRegistry,
  type ContentBlock,
  type MeshSubmitter,
  type SubagentInput,
  type SubagentResult,
  type Tool,
  type ToolExecutorContext,
} from "../src/index.js";
import { z } from "zod";

/** A minimal but complete session (the executor reads collaboration mode). */
function makeSession(): InMemorySession {
  return new InMemorySession(newSessionId(), {
    cwd: process.cwd(),
    permissionMode: "workspace-write",
    startedAt: new Date().toISOString(),
  });
}

/** A `task`-shaped tool whose settle order is controlled per argument. */
function slowEchoTool(delays: Map<string, number>): Tool {
  return {
    name: "task",
    description: "fake task tool",
    parameters: z.object({ objective: z.string() }),
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const { objective } = args as { objective: string };
      const delay = delays.get(objective) ?? 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { content: `done:${objective}` };
    },
  };
}

function noopSubmitter(): MeshSubmitter {
  return {
    async submit(_input: SubagentInput): Promise<SubagentResult> {
      throw new Error("not used");
    },
  };
}

function makeExecutor(options: {
  tools: Tool[];
  session: InMemorySession;
  delays: Map<string, number>;
  maxParallel?: number;
  maxSubagents?: number;
}): ToolExecutor {
  const registry = new ToolRegistry();
  for (const tool of options.tools) registry.register(tool);
  const ctx: ToolExecutorContext = {
    hooks: {
      fire: async () => ({ kind: "continue" }) as never,
    },
    tools: registry,
    session: options.session,
    cwd: process.cwd(),
    getSandboxPolicy: () => ({
      mode: "read-only",
      approval: "on-request",
      backend: "none",
      writableRoots: [],
      networkAccess: false,
      slashTmpWritable: false,
    }),
    getSandboxExecutor: () => undefined,
    getAskHandler: () => undefined,
    getApproval: () => "on-request",
    abortSignal: new AbortController().signal,
    maxSubagents: options.maxSubagents ?? 8,
    meshSubmitter: noopSubmitter(),
    mcpClients: undefined,
    emit: () => {},
    noteToolCall: () => {},
    ...(options.maxParallel !== undefined
      ? { getMaxParallelToolCalls: () => options.maxParallel as number }
      : {}),
  };
  return new ToolExecutor(ctx);
}

function calls(...ids: string[]): Array<Extract<ContentBlock, { type: "tool_call" }>> {
  return ids.map((id) => ({
    type: "tool_call" as const,
    id,
    name: "task",
    args: { objective: id },
  }));
}

/** The `tool_result` contents in transcript order. */
function resultOrder(session: InMemorySession): string[] {
  const out: string[] = [];
  for (const message of session.messages) {
    if (message.role !== "tool") continue;
    for (const block of message.content) {
      if (block.type === "tool_result") out.push(String(block.content));
    }
  }
  return out;
}

describe("parallel tool fan-out commits in model order", () => {
  it("orders results by call index, not completion time", async () => {
    // `c` finishes first, then `b`, then `a` — the transcript must still
    // read a, b, c.
    const delays = new Map([
      ["a", 30],
      ["b", 15],
      ["c", 1],
    ]);
    const session = makeSession();
    const executor = makeExecutor({
      tools: [slowEchoTool(delays)],
      session,
      delays,
      maxParallel: 8,
    });

    await executor.executeMany(calls("a", "b", "c"), 1);

    expect(resultOrder(session)).toEqual(["done:a", "done:b", "done:c"]);
  });

  it("is stable across repeated runs", async () => {
    const delays = new Map([
      ["a", 20],
      ["b", 10],
      ["c", 3],
      ["d", 17],
    ]);
    const orders: string[][] = [];
    for (let run = 0; run < 3; run += 1) {
      const session = makeSession();
      const executor = makeExecutor({
        tools: [slowEchoTool(delays)],
        session,
        delays,
        maxParallel: 4,
      });
      await executor.executeMany(calls("a", "b", "c", "d"), 1);
      orders.push(resultOrder(session));
    }
    expect(orders[0]).toEqual(["done:a", "done:b", "done:c", "done:d"]);
    expect(orders[1]).toEqual(orders[0]);
    expect(orders[2]).toEqual(orders[0]);
  });

  it("bounds concurrency to maxParallel", async () => {
    const delays = new Map([
      ["a", 12],
      ["b", 12],
      ["c", 12],
      ["d", 12],
    ]);
    let active = 0;
    let peak = 0;
    const tool: Tool = {
      name: "task",
      description: "concurrency probe",
      parameters: z.object({ objective: z.string() }),
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const { objective } = args as { objective: string };
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, delays.get(objective) ?? 0));
        active -= 1;
        return { content: `done:${objective}` };
      },
    };
    const session = makeSession();
    const executor = makeExecutor({
      tools: [tool],
      session,
      delays,
      maxParallel: 2,
    });

    await executor.executeMany(calls("a", "b", "c", "d"), 1);

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
    expect(resultOrder(session)).toEqual([
      "done:a",
      "done:b",
      "done:c",
      "done:d",
    ]);
  });

  it("refuses the whole batch past maxSubagents without running it", async () => {
    const delays = new Map<string, number>();
    const session = makeSession();
    let executed = 0;
    const tool: Tool = {
      name: "task",
      description: "counts executions",
      parameters: z.object({ objective: z.string() }),
      isConcurrencySafe: () => true,
      execute: async () => {
        executed += 1;
        return { content: "ran" };
      },
    };
    const executor = makeExecutor({
      tools: [tool],
      session,
      delays,
      maxSubagents: 2,
    });

    await executor.executeMany(calls("a", "b", "c"), 1);

    expect(executed).toBe(0);
    expect(resultOrder(session)).toHaveLength(3);
    expect(resultOrder(session).every((r) => r.includes("maxSubagents"))).toBe(true);
  });

  it("keeps non-task batches serial and unaffected", async () => {
    const session = makeSession();
    const order: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "probe",
      parameters: z.object({ command: z.string() }),
      execute: async (args) => {
        order.push((args as { command: string }).command);
        return { content: "ok" };
      },
    } as Tool);
    const executor = new ToolExecutor({
      hooks: { fire: async () => ({ kind: "continue" }) as never },
      tools: registry,
      session,
      cwd: process.cwd(),
      getSandboxPolicy: () => ({
        mode: "read-only",
        approval: "on-request",
        backend: "none",
        writableRoots: [],
        networkAccess: false,
        slashTmpWritable: false,
      }),
      getSandboxExecutor: () => undefined,
      getAskHandler: () => undefined,
      getApproval: () => "on-request",
      abortSignal: new AbortController().signal,
      maxSubagents: 8,
      meshSubmitter: noopSubmitter(),
      mcpClients: undefined,
      emit: () => {},
      noteToolCall: () => {},
    });

    await executor.executeMany(
      [
        { type: "tool_call", id: "1", name: "bash", args: { command: "one" } },
        { type: "tool_call", id: "2", name: "bash", args: { command: "two" } },
      ],
      1,
    );

    expect(order).toEqual(["one", "two"]);
  });

  it("parallelizes mixed concurrency-safe tools (task + read)", async () => {
    const started: string[] = [];
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let waiting = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "task",
      description: "safe",
      parameters: z.object({ objective: z.string() }),
      isConcurrencySafe: () => true,
      execute: async () => {
        started.push("task");
        waiting += 1;
        if (waiting === 2) releaseGate();
        await gate;
        return { content: "task-done" };
      },
    } as Tool);
    registry.register({
      name: "read_file",
      description: "safe read",
      parameters: z.object({ path: z.string() }),
      isConcurrencySafe: () => true,
      execute: async () => {
        started.push("read_file");
        waiting += 1;
        if (waiting === 2) releaseGate();
        await gate;
        return { content: "read-done" };
      },
    } as Tool);
    const session = makeSession();
    const executor = new ToolExecutor({
      hooks: { fire: async () => ({ kind: "continue" }) as never },
      tools: registry,
      session,
      cwd: process.cwd(),
      getSandboxPolicy: () => ({
        mode: "read-only",
        approval: "on-request",
        backend: "none",
        writableRoots: [],
        networkAccess: false,
        slashTmpWritable: false,
      }),
      getSandboxExecutor: () => undefined,
      getAskHandler: () => undefined,
      getApproval: () => "on-request",
      abortSignal: new AbortController().signal,
      maxSubagents: 8,
      meshSubmitter: noopSubmitter(),
      mcpClients: undefined,
      emit: () => {},
      noteToolCall: () => {},
      getMaxParallelToolCalls: () => 8,
    });

    const done = executor.executeMany(
      [
        {
          type: "tool_call",
          id: "1",
          name: "task",
          args: { objective: "a" },
        },
        {
          type: "tool_call",
          id: "2",
          name: "read_file",
          args: { path: "x" },
        },
      ],
      1,
    );
    await gate;
    expect(started.sort()).toEqual(["read_file", "task"]);
    await done;
    expect(resultOrder(session)).toEqual(["task-done", "read-done"]);
  });

  it("exclusive barrier: bash completes before following task starts", async () => {
    const order: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "exclusive",
      parameters: z.object({ command: z.string() }),
      execute: async () => {
        order.push("bash-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("bash-end");
        return { content: "bash-done" };
      },
    } as Tool);
    registry.register({
      name: "task",
      description: "safe",
      parameters: z.object({ objective: z.string() }),
      isConcurrencySafe: () => true,
      execute: async () => {
        order.push("task-start");
        return { content: "task-done" };
      },
    } as Tool);
    const session = makeSession();
    const executor = new ToolExecutor({
      hooks: { fire: async () => ({ kind: "continue" }) as never },
      tools: registry,
      session,
      cwd: process.cwd(),
      getSandboxPolicy: () => ({
        mode: "read-only",
        approval: "on-request",
        backend: "none",
        writableRoots: [],
        networkAccess: false,
        slashTmpWritable: false,
      }),
      getSandboxExecutor: () => undefined,
      getAskHandler: () => undefined,
      getApproval: () => "on-request",
      abortSignal: new AbortController().signal,
      maxSubagents: 8,
      meshSubmitter: noopSubmitter(),
      mcpClients: undefined,
      emit: () => {},
      noteToolCall: () => {},
      getMaxParallelToolCalls: () => 8,
    });

    await executor.executeMany(
      [
        {
          type: "tool_call",
          id: "1",
          name: "bash",
          args: { command: "echo" },
        },
        {
          type: "tool_call",
          id: "2",
          name: "task",
          args: { objective: "a" },
        },
      ],
      1,
    );

    expect(order).toEqual(["bash-start", "bash-end", "task-start"]);
  });

  it("fail-closed: tools without isConcurrencySafe run as exclusive barriers", async () => {
    const order: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "safe_a",
      description: "safe",
      parameters: z.object({}),
      isConcurrencySafe: () => true,
      execute: async () => {
        order.push("safe_a-start");
        await new Promise((r) => setTimeout(r, 15));
        order.push("safe_a-end");
        return { content: "a" };
      },
    } as Tool);
    registry.register({
      name: "unsafe",
      description: "no flag",
      parameters: z.object({}),
      execute: async () => {
        order.push("unsafe-start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("unsafe-end");
        return { content: "u" };
      },
    } as Tool);
    registry.register({
      name: "safe_b",
      description: "safe",
      parameters: z.object({}),
      isConcurrencySafe: () => true,
      execute: async () => {
        order.push("safe_b-start");
        return { content: "b" };
      },
    } as Tool);
    const session = makeSession();
    const executor = new ToolExecutor({
      hooks: { fire: async () => ({ kind: "continue" }) as never },
      tools: registry,
      session,
      cwd: process.cwd(),
      getSandboxPolicy: () => ({
        mode: "read-only",
        approval: "on-request",
        backend: "none",
        writableRoots: [],
        networkAccess: false,
        slashTmpWritable: false,
      }),
      getSandboxExecutor: () => undefined,
      getAskHandler: () => undefined,
      getApproval: () => "on-request",
      abortSignal: new AbortController().signal,
      maxSubagents: 8,
      meshSubmitter: noopSubmitter(),
      mcpClients: undefined,
      emit: () => {},
      noteToolCall: () => {},
      getMaxParallelToolCalls: () => 8,
    });

    await executor.executeMany(
      [
        { type: "tool_call", id: "1", name: "safe_a", args: {} },
        { type: "tool_call", id: "2", name: "unsafe", args: {} },
        { type: "tool_call", id: "3", name: "safe_b", args: {} },
      ],
      1,
    );

    expect(order).toEqual([
      "safe_a-start",
      "safe_a-end",
      "unsafe-start",
      "unsafe-end",
      "safe_b-start",
    ]);
  });

  it("refuses excess tasks but still runs non-task calls", async () => {
    const session = makeSession();
    let taskRuns = 0;
    let readRuns = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "task",
      description: "task",
      parameters: z.object({ objective: z.string() }),
      isConcurrencySafe: () => true,
      execute: async () => {
        taskRuns += 1;
        return { content: "task" };
      },
    } as Tool);
    registry.register({
      name: "read_file",
      description: "read",
      parameters: z.object({ path: z.string() }),
      isConcurrencySafe: () => true,
      execute: async () => {
        readRuns += 1;
        return { content: "read-ok" };
      },
    } as Tool);
    const executor = new ToolExecutor({
      hooks: { fire: async () => ({ kind: "continue" }) as never },
      tools: registry,
      session,
      cwd: process.cwd(),
      getSandboxPolicy: () => ({
        mode: "read-only",
        approval: "on-request",
        backend: "none",
        writableRoots: [],
        networkAccess: false,
        slashTmpWritable: false,
      }),
      getSandboxExecutor: () => undefined,
      getAskHandler: () => undefined,
      getApproval: () => "on-request",
      abortSignal: new AbortController().signal,
      maxSubagents: 1,
      meshSubmitter: noopSubmitter(),
      mcpClients: undefined,
      emit: () => {},
      noteToolCall: () => {},
    });

    await executor.executeMany(
      [
        {
          type: "tool_call",
          id: "1",
          name: "task",
          args: { objective: "a" },
        },
        {
          type: "tool_call",
          id: "2",
          name: "task",
          args: { objective: "b" },
        },
        {
          type: "tool_call",
          id: "3",
          name: "read_file",
          args: { path: "x" },
        },
      ],
      1,
    );

    expect(taskRuns).toBe(0);
    expect(readRuns).toBe(1);
    const results = resultOrder(session);
    expect(results.filter((r) => r.includes("maxSubagents"))).toHaveLength(2);
    expect(results).toContain("read-ok");
  });

  it("marks real job_list/job_status, list_agents, git/read_file, task as concurrency-safe", async () => {
    const { makeJobTools } = await import("../src/jobs/tools.js");
    const { createLocalJobRegistry } = await import("../src/jobs/index.js");
    const { gitTool } = await import("../src/tools/builtin/git.js");
    const { readFileTool } = await import("../src/tools/builtin/read-file.js");
    const { makeTaskTool } = await import("../src/subagent/tools.js");
    const { makeSubagentControlTools } = await import(
      "../src/subagent/background.js"
    );

    const reg = createLocalJobRegistry();
    const jobTools = makeJobTools(reg);
    const status = jobTools.find((t) => t.name === "job_status")!;
    const list = jobTools.find((t) => t.name === "job_list")!;
    expect(status.isConcurrencySafe?.({})).toBe(true);
    expect(list.isConcurrencySafe?.({})).toBe(true);
    expect(jobTools.find((t) => t.name === "job_start")?.isConcurrencySafe).toBe(
      undefined,
    );
    expect(gitTool.isConcurrencySafe?.({})).toBe(true);
    expect(readFileTool.isConcurrencySafe?.({})).toBe(true);
    expect(
      makeTaskTool(noopSubmitter()).isConcurrencySafe?.({}),
    ).toBe(true);
    const control = makeSubagentControlTools({
      submit: async () => {
        throw new Error("unused");
      },
      getHandle: () => undefined,
      listSubagents: () => [],
    } as never);
    expect(
      control.find((t) => t.name === "list_agents")?.isConcurrencySafe?.({}),
    ).toBe(true);
    await reg.dispose();
  });

  it("safe → exclusive → safe: task group, bash barrier, then task", async () => {
    const order: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "task",
      description: "safe",
      parameters: z.object({ objective: z.string() }),
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const id = (args as { objective: string }).objective;
        order.push(`task-${id}-start`);
        await new Promise((r) => setTimeout(r, 15));
        order.push(`task-${id}-end`);
        return { content: `done:${id}` };
      },
    } as Tool);
    registry.register({
      name: "bash",
      description: "exclusive",
      parameters: z.object({ command: z.string() }),
      execute: async () => {
        order.push("bash-start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("bash-end");
        return { content: "bash" };
      },
    } as Tool);
    const session = makeSession();
    const executor = new ToolExecutor({
      hooks: { fire: async () => ({ kind: "continue" }) as never },
      tools: registry,
      session,
      cwd: process.cwd(),
      getSandboxPolicy: () => ({
        mode: "read-only",
        approval: "on-request",
        backend: "none",
        writableRoots: [],
        networkAccess: false,
        slashTmpWritable: false,
      }),
      getSandboxExecutor: () => undefined,
      getAskHandler: () => undefined,
      getApproval: () => "on-request",
      abortSignal: new AbortController().signal,
      maxSubagents: 8,
      meshSubmitter: noopSubmitter(),
      mcpClients: undefined,
      emit: () => {},
      noteToolCall: () => {},
      getMaxParallelToolCalls: () => 8,
    });

    await executor.executeMany(
      [
        {
          type: "tool_call",
          id: "1",
          name: "task",
          args: { objective: "a" },
        },
        {
          type: "tool_call",
          id: "2",
          name: "task",
          args: { objective: "b" },
        },
        {
          type: "tool_call",
          id: "3",
          name: "bash",
          args: { command: "echo" },
        },
        {
          type: "tool_call",
          id: "4",
          name: "task",
          args: { objective: "c" },
        },
      ],
      1,
    );

    const bashIdx = order.indexOf("bash-start");
    expect(order.indexOf("task-a-end")).toBeLessThan(bashIdx);
    expect(order.indexOf("task-b-end")).toBeLessThan(bashIdx);
    expect(order.indexOf("bash-end")).toBeLessThan(order.indexOf("task-c-start"));
    expect(resultOrder(session)).toEqual([
      "done:a",
      "done:b",
      "bash",
      "done:c",
    ]);
  });
});
