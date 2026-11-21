/**
 * Gap 1–3: parent inbox (followup/steer/inject/whenIdle), activity wait,
 * and work_budget.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  ToolRegistry,
  newSessionId,
  type ModelAdapter,
  type ModelResponse,
} from "../src/index.js";

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

function userTexts(agent: Agent): string[] {
  return agent.session.messages
    .filter((m) => m.role === "user")
    .flatMap((m) =>
      m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text),
    );
}

function makeAgent(
  model: ModelAdapter,
  opts?: { workBudget?: number },
): Agent {
  return new Agent({
    model,
    tools: new ToolRegistry(),
    session: new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    }),
    hooks: new HookRegistry(),
    systemPrompt: "test",
    ...(opts?.workBudget !== undefined ? { workBudget: opts.workBudget } : {}),
  });
}

describe("Agent inbox: followup / steer / inject", () => {
  it("idle followup wakes a turn with the inbox message", async () => {
    let calls = 0;
    const model: ModelAdapter = {
      async complete(req) {
        calls += 1;
        const lastUser = [...req.messages]
          .reverse()
          .find((m) => m.role === "user");
        const body =
          lastUser?.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n") ?? "";
        expect(body).toContain("please continue");
        return { content: [text("noted")], stopReason: "end_turn" };
      },
    };
    const agent = makeAgent(model);
    agent.followup("please continue");
    await agent.whenIdle();
    expect(calls).toBe(1);
    expect(userTexts(agent).some((t) => t.includes("please continue"))).toBe(
      true,
    );
  });

  it("mid-turn steer is flushed before the next model iteration", async () => {
    const tools = new ToolRegistry();
    let sawSteer = false;
    let phase = 0;
    let agent!: Agent;
    tools.register({
      name: "ping",
      description: "ping",
      parameters: z.object({}),
      async execute() {
        agent.steer("steer mid-turn");
        return { content: "pong" };
      },
    });
    agent = new Agent({
      model: {
        async complete(req) {
          phase += 1;
          if (phase === 1) {
            return {
              content: [toolCall("1", "ping", {})],
              stopReason: "tool_use",
            };
          }
          const texts = req.messages
            .filter((m) => m.role === "user")
            .flatMap((m) =>
              m.content
                .filter(
                  (b): b is { type: "text"; text: string } => b.type === "text",
                )
                .map((b) => b.text),
            );
          sawSteer = texts.some((t) => t.includes("steer mid-turn"));
          return { content: [text("after")], stopReason: "end_turn" };
        },
      },
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
    expect(sawSteer).toBe(true);
  });

  it("inject does not wake an idle agent", async () => {
    let calls = 0;
    const model: ModelAdapter = {
      async complete() {
        calls += 1;
        return { content: [text("x")], stopReason: "end_turn" };
      },
    };
    const agent = makeAgent(model);
    agent.inject("parked context");
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(0);
    expect(agent.inbox.nextStepLength).toBe(1);

    // Host turn claims inject at turn-start.
    await agent.run("host");
    expect(userTexts(agent).some((t) => t.includes("parked context"))).toBe(
      true,
    );
  });

  it("whenIdle resolves after a run completes", async () => {
    const agent = makeAgent(scriptedModel([[text("ok")]]));
    const idleP = agent.whenIdle();
    // Already idle → resolves immediately.
    await idleP;
    const pending = agent.whenIdle();
    await agent.run("hi");
    // after run, still idle
    await pending;
    expect(agent.activeTurnId).toBeUndefined();
  });

  it("dispose/abort clears inbox and no-ops further enqueue", async () => {
    let calls = 0;
    const model: ModelAdapter = {
      async complete() {
        calls += 1;
        return { content: [text("x")], stopReason: "end_turn" };
      },
    };
    const agent = makeAgent(model);
    agent.abort("done");
    agent.followup("should not wake");
    agent.steer("nope");
    agent.inject("nope");
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(0);
    expect(agent.inbox.isEmpty).toBe(true);
  });
});

describe("Agent waitForInboxActivity / wait_inbox", () => {
  it("resolves when steer enqueues", async () => {
    const agent = makeAgent(scriptedModel([[text("ok")]]));
    const pending = agent.waitForInboxActivity({ timeoutMs: 2_000 });
    queueMicrotask(() => agent.inject("hello host"));
    const event = await pending;
    expect(event.target).toBe("next-step");
    expect(event.content).toBe("hello host");
  });

  it("wait_inbox tool returns timed_out without failing hard", async () => {
    const tools = new ToolRegistry();
    const agent = new Agent({
      model: scriptedModel([
        [toolCall("1", "wait_inbox", { timeout_ms: 50 })],
        [text("after wait")],
      ]),
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    // wait_inbox is registered by Agent constructor on its tools registry.
    await agent.run("wait");
    const toolMsg = agent.session.messages.find((m) => m.role === "tool");
    const content = toolMsg?.content.find((b) => b.type === "tool_result");
    const raw =
      content && content.type === "tool_result"
        ? typeof content.content === "string"
          ? content.content
          : JSON.stringify(content.content)
        : "";
    expect(raw).toContain("timed_out");
  });
});

describe("work_budget", () => {
  it("refuses tool batches when work_budget is exhausted", async () => {
    const tools = new ToolRegistry();
    let executed = 0;
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute(args) {
        executed += 1;
        return { content: String((args as { text: string }).text) };
      },
    });
    const agent = new Agent({
      model: scriptedModel([
        [toolCall("1", "echo", { text: "a" })],
        [toolCall("2", "echo", { text: "b" })],
        [text("done")],
      ]),
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      workBudget: 1,
    });
    await agent.run("go");
    expect(executed).toBe(1);
    const results = agent.session.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) =>
        m.content
          .filter((b) => b.type === "tool_result")
          .map((b) =>
            typeof (b as { content: unknown }).content === "string"
              ? (b as { content: string }).content
              : JSON.stringify((b as { content: unknown }).content),
          ),
      );
    expect(results.some((r) => r.includes("work_budget exhausted"))).toBe(true);
  });

  it("refuses a new host run when work_budget is already 0", async () => {
    let calls = 0;
    const model: ModelAdapter = {
      async complete() {
        calls += 1;
        return { content: [text("should not run")], stopReason: "end_turn" };
      },
    };
    const agent = makeAgent(model, { workBudget: 0 });
    const result = await agent.run("go");
    expect(calls).toBe(0);
    expect(result.stopReason).toBe("aborted");
    expect(
      result.content.some(
        (b) =>
          b.type === "text" && b.text.includes("work_budget exhausted"),
      ),
    ).toBe(true);
  });

  it("blocks idle followup wake when work_budget is exhausted", async () => {
    let calls = 0;
    const model: ModelAdapter = {
      async complete() {
        calls += 1;
        return { content: [text("ok")], stopReason: "end_turn" };
      },
    };
    const agent = makeAgent(model, { workBudget: 0 });
    agent.followup("please wake");
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(0);
    expect(agent.inbox.nextTurnLength).toBe(1);
  });
});

describe("Gap 1: inbox forensic events", () => {
  it("followup + flush records inbox_splice and inbox_claim events", async () => {
    const agent = makeAgent(scriptedModel([[text("ok")]]));
    agent.inject("parked");
    expect(
      (agent.session.events?.() ?? []).some(
        (e) => e.kind === "inbox_splice" && e.detail?.includes("next-step"),
      ),
    ).toBe(true);
    await agent.run("host");
    expect(
      (agent.session.events?.() ?? []).some((e) => e.kind === "inbox_claim"),
    ).toBe(true);
  });
});

describe("Gap 1: pendingChildren stale on resume", () => {
  it("marks header children stale when no live handle", () => {
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
      pendingChildren: [
        {
          sessionId: "gone-child",
          objective: "old work",
          status: "running",
          startedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const agent = new Agent({
      model: scriptedModel([[text("ok")]]),
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    expect(agent.session.getPendingChildren()[0]?.status).toBe("stale");
  });
});

describe("Gap 4b: durable pending inbox", () => {
  it("mirrors inject onto session.metadata.pendingInbox", () => {
    const agent = makeAgent(scriptedModel([[text("ok")]]));
    agent.inject("parked");
    const pending = agent.session.getPendingInbox();
    expect(pending?.nextStep).toHaveLength(1);
    expect(pending?.nextStep[0]?.content).toBe("parked");
    expect(pending?.nextTurn).toHaveLength(0);
  });

  it("clears pendingInbox after turn-start claim", async () => {
    const agent = makeAgent(scriptedModel([[text("ok")]]));
    agent.inject("parked");
    expect(agent.session.getPendingInbox()?.nextStep).toHaveLength(1);
    await agent.run("host");
    expect(agent.session.getPendingInbox()).toBeUndefined();
    expect(userTexts(agent)).toContain("parked");
  });

  it("restores pending queues on Agent construct without waking", async () => {
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
      pendingInbox: {
        nextTurn: [
          {
            target: "next-turn",
            content: "resume-me",
            enqueuedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        nextStep: [],
      },
    });
    let calls = 0;
    const model: ModelAdapter = {
      async complete() {
        calls += 1;
        return { content: [text("woke")], stopReason: "end_turn" };
      },
    };
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    // Construct must not auto-wake.
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(0);
    expect(agent.inbox.nextTurnLength).toBe(1);
    await agent.run("host");
    expect(userTexts(agent)).toContain("resume-me");
    expect(agent.session.getPendingInbox()).toBeUndefined();
  });
});

