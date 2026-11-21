/**
 * Phase C polish: child permission inherit, repeat-tool reminder,
 * settlement wake budget, dispose guard.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  LocalMeshSubmitter,
  ToolRegistry,
  defaultBuildSubagentFactory,
  newSessionId,
  type ModelAdapter,
  type ModelResponse,
  type SubagentInput,
} from "../src/index.js";
import { policyFromMode } from "../src/permissions/policy.js";

function text(t: string): ModelResponse["content"][number] {
  return { type: "text", text: t };
}

function toolCall(
  id: string,
  name: string,
  args: unknown,
): ModelResponse["content"][number] {
  return { type: "tool_call", id, name, args };
}

function scriptedModel(
  responses: ReadonlyArray<ModelResponse["content"]>,
): ModelAdapter {
  let i = 0;
  return {
    async complete() {
      const content = responses[i++] ?? [text("done")];
      const stopReason = content.some((b) => b.type === "tool_call")
        ? "tool_use"
        : "end_turn";
      return { content, stopReason };
    },
  };
}

describe("C1 child permission inherit", () => {
  it("seeds child session/mode from getPermissionMode at spawn", async () => {
    let liveMode: "read-only" | "workspace-write" = "workspace-write";
    const childModel = scriptedModel([[text("child-ok")]]);
    const factory = defaultBuildSubagentFactory({
      model: childModel,
      permissionMode: "read-only",
      getPermissionMode: () => liveMode,
      getSandboxPolicy: () => policyFromMode(liveMode, "/tmp"),
    });
    const captured: Array<{ mode: string; sandbox: string }> = [];
    const wrapped = (input: SubagentInput) => {
      const agent = factory(input);
      captured.push({
        mode: agent.session.metadata.permissionMode ?? "",
        sandbox: agent.sandboxPolicy.mode,
      });
      return agent;
    };
    const submitter = new LocalMeshSubmitter({
      buildSubagent: wrapped,
      workerPeerId: "local",
    });
    await submitter.submit(
      {
        objective: "inherit",
        capabilityTag: "research",
        costCeilingUsd: 0.1,
        deadlineMs: 5_000,
      },
      new AbortController().signal,
    );
    expect(captured).toEqual([
      { mode: "workspace-write", sandbox: "workspace-write" },
    ]);

    liveMode = "read-only";
    await submitter.submit(
      {
        objective: "inherit-2",
        capabilityTag: "research",
        costCeilingUsd: 0.1,
        deadlineMs: 5_000,
      },
      new AbortController().signal,
    );
    expect(captured[1]).toEqual({
      mode: "read-only",
      sandbox: "read-only",
    });
  });
});

function userSystemTexts(agent: Agent): string[] {
  return agent.session.messages
    .filter((m) => m.role === "user")
    .flatMap((m) =>
      m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text),
    )
    .filter((t) => t.includes("[system]"));
}

describe("C2 repeat-tool reminder", () => {
  it("injects a reminder after identical successful tool calls", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute(args) {
        return { content: String((args as { text: string }).text) };
      },
    });
    const model = scriptedModel([
      [toolCall("1", "echo", { text: "same" })],
      [toolCall("2", "echo", { text: "same" })],
      [toolCall("3", "echo", { text: "same" })],
      [text("done")],
    ]);
    const agent = new Agent({
      model,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    await agent.run("go");
    expect(
      userSystemTexts(agent).some(
        (t) => t.includes("echo") && t.includes("3 times successfully"),
      ),
    ).toBe(true);
  });

  it("does not remind after only two identical successes", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute(args) {
        return { content: String((args as { text: string }).text) };
      },
    });
    const model = scriptedModel([
      [toolCall("1", "echo", { text: "same" })],
      [toolCall("2", "echo", { text: "same" })],
      [text("done")],
    ]);
    const agent = new Agent({
      model,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    await agent.run("go");
    expect(
      userSystemTexts(agent).some((t) => t.includes("times successfully")),
    ).toBe(false);
  });

  it("reminds again at six identical successes", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute(args) {
        return { content: String((args as { text: string }).text) };
      },
    });
    const model = scriptedModel([
      [toolCall("1", "echo", { text: "same" })],
      [toolCall("2", "echo", { text: "same" })],
      [toolCall("3", "echo", { text: "same" })],
      [toolCall("4", "echo", { text: "same" })],
      [toolCall("5", "echo", { text: "same" })],
      [toolCall("6", "echo", { text: "same" })],
      [text("done")],
    ]);
    const agent = new Agent({
      model,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    await agent.run("go");
    const reminders = userSystemTexts(agent).filter((t) =>
      t.includes("times successfully"),
    );
    expect(reminders.some((t) => t.includes("3 times successfully"))).toBe(
      true,
    );
    expect(reminders.some((t) => t.includes("6 times successfully"))).toBe(
      true,
    );
  });

  it("resets the success streak after a failure of the same call", async () => {
    const tools = new ToolRegistry();
    let n = 0;
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute(args) {
        n += 1;
        if (n === 3) {
          return { content: "boom", isError: true };
        }
        return { content: String((args as { text: string }).text) };
      },
    });
    const model = scriptedModel([
      [toolCall("1", "echo", { text: "same" })],
      [toolCall("2", "echo", { text: "same" })],
      [toolCall("3", "echo", { text: "same" })],
      [toolCall("4", "echo", { text: "same" })],
      [toolCall("5", "echo", { text: "same" })],
      [toolCall("6", "echo", { text: "same" })],
      [text("done")],
    ]);
    const agent = new Agent({
      model,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    await agent.run("go");
    const successReminders = userSystemTexts(agent).filter((t) =>
      t.includes("times successfully"),
    );
    // After failure at call 3, success streak restarts: reminders at 3 post-reset
    // (calls 4–6) → "3 times successfully", not "6".
    expect(successReminders.some((t) => t.includes("6 times successfully"))).toBe(
      false,
    );
    expect(successReminders.some((t) => t.includes("3 times successfully"))).toBe(
      true,
    );
  });

  it("tracks different args as separate streaks", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute(args) {
        return { content: String((args as { text: string }).text) };
      },
    });
    const model = scriptedModel([
      [toolCall("1", "echo", { text: "a" })],
      [toolCall("2", "echo", { text: "b" })],
      [toolCall("3", "echo", { text: "a" })],
      [toolCall("4", "echo", { text: "b" })],
      [text("done")],
    ]);
    const agent = new Agent({
      model,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    await agent.run("go");
    expect(
      userSystemTexts(agent).some((t) => t.includes("times successfully")),
    ).toBe(false);
  });
});

describe("C1 sandbox inherit edges", () => {
  it("applies getSandboxPolicy even when permissionMode snapshot differs", async () => {
    const childModel = scriptedModel([[text("ok")]]);
    const factory = defaultBuildSubagentFactory({
      model: childModel,
      permissionMode: "read-only",
      getSandboxPolicy: () => policyFromMode("workspace-write", "/tmp"),
    });
    const agent = factory({
      objective: "x",
      capabilityTag: "research",
      costCeilingUsd: 0.1,
      deadlineMs: 5_000,
    });
    expect(agent.session.metadata.permissionMode).toBe("read-only");
    expect(agent.sandboxPolicy.mode).toBe("workspace-write");
  });

  it("falls back to construction snapshot when getters are absent", async () => {
    const childModel = scriptedModel([[text("ok")]]);
    const factory = defaultBuildSubagentFactory({
      model: childModel,
      permissionMode: "read-only",
    });
    const agent = factory({
      objective: "x",
      capabilityTag: "research",
      costCeilingUsd: 0.1,
      deadlineMs: 5_000,
    });
    expect(agent.session.metadata.permissionMode).toBe("read-only");
    expect(agent.sandboxPolicy.mode).toBe("read-only");
  });
});

describe("C4 wake budget + dispose", () => {
  it("stops auto followups after maxConsecutiveSettlementWakes", async () => {
    let runs = 0;
    const model: ModelAdapter = {
      async complete() {
        runs += 1;
        return {
          content: [text(`r${runs}`)],
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
      settlementFollowup: true,
      maxConsecutiveSettlementWakes: 2,
    });

    agent.enqueueSettlementNotice("[system] Job settled: wake-1");
    await new Promise((r) => setTimeout(r, 50));
    agent.enqueueSettlementNotice("[system] Job settled: wake-2");
    await new Promise((r) => setTimeout(r, 50));
    agent.enqueueSettlementNotice("[system] Job settled: wake-3");
    await new Promise((r) => setTimeout(r, 80));

    // Budget 2: third notice should queue, not start another run.
    expect(runs).toBeLessThanOrEqual(2);
    expect(agent.pendingSettlementNotices.length).toBeGreaterThanOrEqual(1);
  });

  it("dispose/abort prevents further settlement followup runs", async () => {
    let runs = 0;
    const model: ModelAdapter = {
      async complete() {
        runs += 1;
        return {
          content: [text("x")],
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
      settlementFollowup: true,
    });
    agent.abort("done");
    agent.enqueueSettlementNotice("[system] Job settled: after-dispose");
    await new Promise((r) => setTimeout(r, 30));
    expect(runs).toBe(0);
    expect(agent.pendingSettlementNotices).toHaveLength(0);
  });

  it("host run() resets the wake budget so followups can resume", async () => {
    let runs = 0;
    const model: ModelAdapter = {
      async complete() {
        runs += 1;
        return {
          content: [text(`r${runs}`)],
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
      settlementFollowup: true,
      maxConsecutiveSettlementWakes: 1,
    });

    agent.enqueueSettlementNotice("[system] Job settled: wake-1");
    await new Promise((r) => setTimeout(r, 40));
    agent.enqueueSettlementNotice("[system] Job settled: wake-2");
    await new Promise((r) => setTimeout(r, 40));
    expect(runs).toBe(1);
    expect(agent.pendingSettlementNotices.length).toBeGreaterThanOrEqual(1);

    const beforeHost = runs;
    await agent.run("human turn");
    // Host turn itself + drained queued notice as a new followup after reset.
    expect(runs).toBeGreaterThan(beforeHost);
  });

  it("prefers onIdleSettlement over settlementFollowup auto-run", async () => {
    let runs = 0;
    let hooked = 0;
    const model: ModelAdapter = {
      async complete() {
        runs += 1;
        return {
          content: [text("x")],
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
      settlementFollowup: true,
      onIdleSettlement: async () => {
        hooked += 1;
      },
    });
    agent.enqueueSettlementNotice("[system] Job settled: hook-path");
    await new Promise((r) => setTimeout(r, 30));
    expect(hooked).toBe(1);
    expect(runs).toBe(0);
  });

  it("queues a second notice while a settlement followup is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let completes = 0;
    const model: ModelAdapter = {
      async complete() {
        completes += 1;
        if (completes === 1) {
          await gate;
        }
        return {
          content: [text(`r${completes}`)],
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
      settlementFollowup: true,
      maxConsecutiveSettlementWakes: 5,
    });

    agent.enqueueSettlementNotice("[system] Job settled: first");
    await new Promise((r) => setTimeout(r, 20));
    expect(completes).toBe(1);

    agent.enqueueSettlementNotice("[system] Job settled: second");
    await new Promise((r) => setTimeout(r, 20));
    // Still inside first followup — second notice queued, no extra complete yet.
    expect(completes).toBe(1);
    expect(
      agent.pendingSettlementNotices.some((n) => n.includes("second")),
    ).toBe(true);

    release();
    await new Promise((r) => setTimeout(r, 60));
    // Chained drain should consume the queued notice.
    expect(completes).toBeGreaterThanOrEqual(2);
    expect(agent.pendingSettlementNotices).toHaveLength(0);
  });

  it("drains multiple pending notices into one chained followup prompt", async () => {
    const seenPrompts: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let completes = 0;
    const model: ModelAdapter = {
      async complete(req) {
        completes += 1;
        const lastUser = [...req.messages]
          .reverse()
          .find((m) => m.role === "user");
        const textBlocks =
          lastUser?.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n") ?? "";
        seenPrompts.push(textBlocks);
        if (completes === 1) {
          await gate;
        }
        return {
          content: [text(`r${completes}`)],
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
      settlementFollowup: true,
      maxConsecutiveSettlementWakes: 5,
    });

    agent.enqueueSettlementNotice("[system] Job settled: alpha");
    await new Promise((r) => setTimeout(r, 20));
    agent.enqueueSettlementNotice("[system] Job settled: beta");
    agent.enqueueSettlementNotice("[system] Job settled: gamma");
    release();
    await new Promise((r) => setTimeout(r, 80));

    expect(completes).toBeGreaterThanOrEqual(2);
    const joined = seenPrompts.slice(1).join("\n");
    expect(joined).toContain("beta");
    expect(joined).toContain("gamma");
    expect(agent.pendingSettlementNotices).toHaveLength(0);
  });
});

describe("C2 repeat failure streak", () => {
  it("hints again on the 4th identical failure", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "fail",
      description: "fail",
      parameters: z.object({ reason: z.string() }),
      async execute() {
        return { content: "boom", isError: true };
      },
    });
    const model = scriptedModel([
      [toolCall("1", "fail", { reason: "x" })],
      [toolCall("2", "fail", { reason: "x" })],
      [toolCall("3", "fail", { reason: "x" })],
      [toolCall("4", "fail", { reason: "x" })],
      [text("stop")],
    ]);
    const agent = new Agent({
      model,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    await agent.run("go");
    const hints = userSystemTexts(agent).filter((t) =>
      t.includes("Do NOT repeat that exact call"),
    );
    // Hints at failure counts 2 and 4.
    expect(hints.length).toBeGreaterThanOrEqual(2);
    expect(hints.some((t) => t.includes("2 times"))).toBe(true);
    expect(hints.some((t) => t.includes("4 times"))).toBe(true);
  });

  it("restarts the failure streak after a success", async () => {
    const tools = new ToolRegistry();
    let n = 0;
    tools.register({
      name: "flaky",
      description: "flaky",
      parameters: z.object({ x: z.string() }),
      async execute() {
        n += 1;
        if (n === 3) return { content: "ok" };
        return { content: "boom", isError: true };
      },
    });
    const model = scriptedModel([
      [toolCall("1", "flaky", { x: "a" })],
      [toolCall("2", "flaky", { x: "a" })],
      [toolCall("3", "flaky", { x: "a" })],
      [toolCall("4", "flaky", { x: "a" })],
      [toolCall("5", "flaky", { x: "a" })],
      [text("done")],
    ]);
    const agent = new Agent({
      model,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    await agent.run("go");
    const hints = userSystemTexts(agent).filter((t) =>
      t.includes("Do NOT repeat that exact call"),
    );
    // Fail×2 → hint@2; success clears; fail×2 → hint@2 again.
    expect(hints.filter((t) => t.includes("2 times")).length).toBeGreaterThanOrEqual(
      2,
    );
  });
});
