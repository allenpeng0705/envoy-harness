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
});
