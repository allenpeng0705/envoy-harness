/**
 * Gap 9 — Guardian reviewer in executeMany.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  ToolRegistry,
  newSessionId,
  type GuardianReviewer,
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

describe("GuardianReviewer", () => {
  it("NullGuardian allows tool batches", async () => {
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
    const model: ModelAdapter = {
      async complete() {
        return {
          content: [toolCall("1", "echo", { text: "hi" }), text("done")],
          stopReason: "end_turn",
        };
      },
    };
    // First response with tool, second end — scripted better:
    let i = 0;
    const scripted: ModelAdapter = {
      async complete() {
        i += 1;
        if (i === 1) {
          return {
            content: [toolCall("1", "echo", { text: "hi" })],
            stopReason: "tool_use",
          };
        }
        return { content: [text("done")], stopReason: "end_turn" };
      },
    };
    void model;
    const agent = new Agent({
      model: scripted,
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
    expect(executed).toBe(1);
  });

  it("blocking reviewer short-circuits the batch", async () => {
    const tools = new ToolRegistry();
    let executed = 0;
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute() {
        executed += 1;
        return { content: "x" };
      },
    });
    const guardian: GuardianReviewer = {
      reviewToolBatch() {
        return { decision: "block", reason: "test deny", score: 0.9 };
      },
    };
    let i = 0;
    const model: ModelAdapter = {
      async complete() {
        i += 1;
        if (i === 1) {
          return {
            content: [toolCall("1", "echo", { text: "hi" })],
            stopReason: "tool_use",
          };
        }
        return { content: [text("done")], stopReason: "end_turn" };
      },
    };
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
      guardian,
    });
    await agent.run("go");
    expect(executed).toBe(0);
    const toolMsg = agent.session.messages.find((m) => m.role === "tool");
    const raw = JSON.stringify(toolMsg?.content ?? []);
    expect(raw).toContain("guardian blocked");
    expect(
      agent.session.diagnostics?.().some((d) => d.kind === "guardian_review"),
    ).toBe(true);
  });

  it("scored allow records diagnostic but still runs tools", async () => {
    const tools = new ToolRegistry();
    let executed = 0;
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute() {
        executed += 1;
        return { content: "ok" };
      },
    });
    const guardian: GuardianReviewer = {
      reviewToolBatch() {
        return { decision: "allow", score: 0.1, reason: "low risk" };
      },
    };
    let i = 0;
    const model: ModelAdapter = {
      async complete() {
        i += 1;
        if (i === 1) {
          return {
            content: [toolCall("1", "echo", { text: "hi" })],
            stopReason: "tool_use",
          };
        }
        return { content: [text("done")], stopReason: "end_turn" };
      },
    };
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
      guardian,
    });
    await agent.run("go");
    expect(executed).toBe(1);
    expect(
      agent.session
        .diagnostics?.()
        .some(
          (d) =>
            d.kind === "guardian_review" &&
            d.detail?.includes("allow") &&
            d.detail.includes("0.1"),
        ),
    ).toBe(true);
  });

  it("NullGuardian does not spam guardian_review diagnostics", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute() {
        return { content: "ok" };
      },
    });
    let i = 0;
    const model: ModelAdapter = {
      async complete() {
        i += 1;
        if (i === 1) {
          return {
            content: [toolCall("1", "echo", { text: "hi" })],
            stopReason: "tool_use",
          };
        }
        return { content: [text("done")], stopReason: "end_turn" };
      },
    };
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
      agent.session.diagnostics?.().some((d) => d.kind === "guardian_review"),
    ).toBe(false);
  });
});
