/**
 * Agent loop tests.
 *
 * The agent loop is the heart of envoy-harness. These tests
 * drive it with a `FakeModel` (in `test/fixtures/`) and verify
 * each branch of the loop:
 *
 * 1. Single-turn: model emits text, agent exits.
 * 2. Tool call: model emits a tool_call, agent executes, loop continues.
 * 3. Multi-step: model emits 2+ tool calls across turns, agent chains.
 * 4. Hook block: PreToolUse hook blocks, agent surfaces as tool result.
 * 5. Unknown tool: model emits a name not in the registry.
 * 6. Invalid args: model emits args that don't match the zod schema.
 * 7. Max iterations: agent throws after the bound.
 * 8. Abort: external signal stops the loop.
 * 9. Model error: model throws, agent surfaces in transcript.
 * 10. PostToolUse modify: hook rewrites the result before the model sees it.
 * 11. Tool execution error: tool throws, agent catches and reports.
 *
 * **Test isolation:** every test gets a fresh `Agent` + `Session`
 * + `ToolRegistry` + `FakeModel`. The `HookRegistry` is also
 * fresh to keep `use()` / `on()` registrations from leaking.
 */

import * as os from "node:os";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  newSessionId,
  ToolRegistry,
  type ModelAdapter,
  type ModelResponse,
  type Session,
  type SessionMetadata,
  type Tool,
} from "../src/index.js";

import {
  FakeModel,
  textResponse,
  toolCall,
} from "./fixtures/fake-model.js";

function makeSession(): Session {
  const meta: SessionMetadata = {
    cwd: os.tmpdir(),
    permissionMode: "workspace-write",
    startedAt: new Date().toISOString(),
  };
  return new InMemorySession(newSessionId(), meta);
}

const echoTool: Tool<z.ZodObject<{ message: z.ZodString }>> = {
  name: "echo",
  description: "Echo a message.",
  parameters: z.object({ message: z.string() }),
  async execute({ message }) {
    return { content: message };
  },
};

const failTool: Tool<z.ZodObject<{ reason: z.ZodString }>> = {
  name: "fail",
  description: "Always throws.",
  parameters: z.object({ reason: z.string() }),
  async execute() {
    throw new Error("intentional failure");
  },
};

function makeAgent(
  model: ModelAdapter,
  opts: {
    tools?: Tool[];
    hooks?: HookRegistry;
    systemPrompt?: string;
    maxIterations?: number;
    abortSignal?: AbortSignal;
  } = {},
): { agent: Agent; tools: ToolRegistry; session: Session; hooks: HookRegistry } {
  const tools = new ToolRegistry();
  for (const t of opts.tools ?? [echoTool]) tools.register(t);
  const session = makeSession();
  const hooks = opts.hooks ?? new HookRegistry();
  // exactOptionalPropertyTypes: true — only include fields that
  // are actually set. Passing `undefined` would be a type error.
  const agent = new Agent({
    model,
    tools,
    session,
    hooks,
    ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
    ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
    ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
  });
  return { agent, tools, session, hooks };
}

describe("Agent: single-turn", () => {
  it("returns the model's text when there are no tool calls", async () => {
    const model = new FakeModel([textResponse("hello there")]);
    const { agent, session } = makeAgent(model);
    const result = await agent.run("hi");
    expect(result.stopReason).toBe("end_turn");
    expect(result.content[0]).toEqual({ type: "text", text: "hello there" });
    // Transcript: system? (no) + user + assistant.
    expect(session.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("passes the prompt and tools to the model", async () => {
    const model = new FakeModel([textResponse("ok")]);
    const { agent } = makeAgent(model);
    await agent.run("what time is it?");
    expect(model.calls[0]?.messages[0]?.role).toBe("user");
    expect(model.calls[0]?.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "what time is it?",
    });
    // The model sees the tool list.
    expect(model.calls[0]?.tools.map((t) => t.name)).toContain("echo");
  });

  it("appends a system prompt at the start when provided", async () => {
    const model = new FakeModel([textResponse("ok")]);
    const { agent, session } = makeAgent(model, {
      systemPrompt: "you are envoy-harness",
    });
    await agent.run("hi");
    expect(session.messages[0]?.role).toBe("system");
    expect(session.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "you are envoy-harness",
    });
  });
});

describe("Agent: tool call flow", () => {
  it("executes a tool call and feeds the result back to the model", async () => {
    const model = new FakeModel([
      // First call: model emits a tool call.
      { content: [toolCall("tc1", "echo", { message: "ping" })] },
      // Second call: model emits text (no tool calls) — done.
      textResponse("done"),
    ]);
    const { agent, session } = makeAgent(model);
    const result = await agent.run("please echo ping");
    expect(result.stopReason).toBe("end_turn");
    expect(result.content[0]).toEqual({ type: "text", text: "done" });
    // Transcript: user, assistant(tool_call), tool(result), assistant(text).
    expect(session.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    // The tool result message carries the echo output.
    const toolMsg = session.messages[2];
    expect(toolMsg?.content[0]).toEqual({
      type: "tool_result",
      toolCallId: "tc1",
      content: "ping",
      isError: false,
    });
  });

  it("chains multiple tool calls in a single response", async () => {
    const model = new FakeModel([
      {
        content: [
          toolCall("tc1", "echo", { message: "first" }),
          toolCall("tc2", "echo", { message: "second" }),
        ],
      },
      textResponse("all done"),
    ]);
    const { agent, session } = makeAgent(model);
    await agent.run("do both");
    // Expect: user, assistant(2 calls), tool(2 results), assistant(done).
    // Actually, our impl appends ONE tool message per call (each with
    // its own tool_result block). Verify by content shape.
    const toolMessages = session.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content[0]).toMatchObject({
      type: "tool_result",
      toolCallId: "tc1",
      content: "first",
    });
    expect(toolMessages[1]?.content[0]).toMatchObject({
      type: "tool_result",
      toolCallId: "tc2",
      content: "second",
    });
  });

  it("handles an unknown tool name gracefully", async () => {
    const model = new FakeModel([
      { content: [toolCall("tc1", "no_such_tool", {})] },
      textResponse("recovered"),
    ]);
    const { agent, session } = makeAgent(model);
    const result = await agent.run("go");
    expect(result.stopReason).toBe("end_turn");
    // The tool result is an error, not a throw.
    const toolMsg = session.messages.find(
      (m) => m.role === "tool",
    );
    expect(toolMsg?.content[0]).toMatchObject({
      type: "tool_result",
      isError: true,
    });
    expect((toolMsg?.content[0] as { content: string }).content).toMatch(
      /unknown tool/,
    );
  });

  it("handles invalid args gracefully (zod validation failure)", async () => {
    const model = new FakeModel([
      // echo expects { message: string }; pass a number.
      { content: [toolCall("tc1", "echo", { message: 123 })] },
      textResponse("recovered"),
    ]);
    const { agent, session } = makeAgent(model);
    await agent.run("go");
    const toolMsg = session.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({
      type: "tool_result",
      isError: true,
    });
    expect((toolMsg?.content[0] as { content: string }).content).toMatch(
      /invalid arguments/,
    );
  });

  it("captures a tool's exception and surfaces it as isError", async () => {
    const model = new FakeModel([
      { content: [toolCall("tc1", "fail", { reason: "x" })] },
      textResponse("recovered"),
    ]);
    const { agent, session } = makeAgent(model, { tools: [echoTool, failTool] });
    await agent.run("go");
    const toolMsg = session.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({
      type: "tool_result",
      isError: true,
    });
    expect((toolMsg?.content[0] as { content: string }).content).toMatch(
      /intentional failure/,
    );
  });
});

describe("Agent: hooks", () => {
  it("respects PreToolUse block — no tool execution, isError in transcript", async () => {
    const hooks = new HookRegistry();
    hooks.on("PreToolUse", async () => ({
      kind: "block",
      reason: "denied by test",
    }));
    const model = new FakeModel([
      { content: [toolCall("tc1", "echo", { message: "x" })] },
      textResponse("ok"),
    ]);
    const { agent, session } = makeAgent(model, { hooks });
    await agent.run("go");
    const toolMsg = session.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({
      type: "tool_result",
      isError: true,
    });
    expect((toolMsg?.content[0] as { content: string }).content).toMatch(
      /blocked by PreToolUse: denied by test/,
    );
  });

  it("honors PostToolUse modify — the model sees the modified result", async () => {
    const hooks = new HookRegistry();
    hooks.on("PostToolUse", async () => ({
      kind: "modify",
      modified: { content: "MODIFIED", isError: false },
    }));
    const model = new FakeModel([
      { content: [toolCall("tc1", "echo", { message: "x" })] },
      textResponse("ok"),
    ]);
    const { agent, session } = makeAgent(model, { hooks });
    await agent.run("go");
    const toolMsg = session.messages.find((m) => m.role === "tool");
    expect((toolMsg?.content[0] as { content: string }).content).toBe(
      "MODIFIED",
    );
  });
});

describe("Agent: limits and abort", () => {
  it("throws when maxIterations is exceeded", async () => {
    // Scripted: model always returns a tool call (never reaches end_turn).
    const script: ModelResponse[] = [];
    for (let i = 0; i < 10; i++) {
      script.push({
        content: [toolCall(`tc${i}`, "echo", { message: `m${i}` })],
        stopReason: "tool_use",
      });
    }
    const model = new FakeModel(script);
    const { agent } = makeAgent(model, { maxIterations: 3 });
    await expect(agent.run("loop forever")).rejects.toThrow(
      /max iterations/,
    );
  });

  it("aborts cleanly on external abort signal", async () => {
    const controller = new AbortController();
    const model = new FakeModel([textResponse("never reached")]);
    const { agent } = makeAgent(model, { abortSignal: controller.signal });
    // Abort before the first iteration.
    controller.abort();
    const result = await agent.run("hi");
    expect(result.stopReason).toBe("aborted");
    expect(result.content).toEqual([]);
  });

  it("agent.abort() can be called from outside", async () => {
    const model = new FakeModel([textResponse("never reached")]);
    const { agent } = makeAgent(model);
    agent.abort("user-cancelled");
    const result = await agent.run("hi");
    expect(result.stopReason).toBe("aborted");
  });
});

describe("Agent: model errors", () => {
  it("surfaces a model error in the transcript and exits", async () => {
    const model = new FakeModel([{ error: new Error("API down") }]);
    const { agent, session } = makeAgent(model);
    const result = await agent.run("hi");
    expect(result.stopReason).toBe("aborted");
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: /\[model error\] API down/,
    });
    // The transcript has the error as an assistant message.
    const last = session.lastMessage();
    expect(last?.role).toBe("assistant");
    expect((last?.content[0] as { text: string }).text).toMatch(/API down/);
  });
});

describe("Agent: stop-reason pass-through", () => {
  it("passes through max_tokens from the model", async () => {
    const model = new FakeModel([
      { content: [toolCall("tc1", "echo", { message: "x" })], stopReason: "max_tokens" },
      // Not reached — agent exits because max_tokens + tool call is end-of-turn.
    ]);
    const { agent } = makeAgent(model);
    const result = await agent.run("go");
    expect(result.stopReason).toBe("max_tokens");
  });

  it("counts iterations and toolCalls", async () => {
    const model = new FakeModel([
      {
        content: [
          toolCall("tc1", "echo", { message: "a" }),
          toolCall("tc2", "echo", { message: "b" }),
        ],
      },
      textResponse("done"),
    ]);
    const { agent } = makeAgent(model);
    const result = await agent.run("go");
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(2);
  });
});

describe("Agent: ContentBlock typing smoke", () => {
  it("can build a transcript manually and pass it to the model", async () => {
    // This test doesn't use the loop — it just verifies the types
    // compose. The model receives the full transcript.
    const model = new FakeModel([textResponse("ok")]);
    const { agent, session } = makeAgent(model);
    // Pre-populate with a fake prior turn.
    session.appendMessage("user", [{ type: "text", text: "earlier" }]);
    session.appendMessage("assistant", [{ type: "text", text: "earlier-reply" }]);
    await agent.run("now");
    // The model saw: earlier-user, earlier-assistant, now-user.
    // The 4th message (assistant with "ok") is the response, not
    // the input — so it shouldn't be in `messages` (which is the
    // input to the model).
    const lastCall = model.calls[model.calls.length - 1];
    expect(lastCall?.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });
});
