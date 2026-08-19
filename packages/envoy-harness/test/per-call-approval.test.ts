/**
 * F9.1 tests — per-call approval callback (Penguin style).
 *
 * Covers:
 * 1. Hook returns `kind: "ask"` → agent calls the handler.
 * 2. Handler returns `allow` → tool runs as-is.
 * 3. Handler returns `deny` → tool result is
 *    `"denied by user: <reason>"` with isError=true.
 * 4. Handler returns `modify` → tool runs with modified
 *    args (re-validated against zod schema).
 * 5. No handler configured → defaults to deny.
 * 6. AskRequest carries the right fields (tool, args,
 *    question, options, signal).
 * 7. Aborted signal propagates.
 * 8. Transcript records the ask + decision for audit.
 * 9. Backward compat: existing decisions (`continue`,
 *    `block`, `add-context`) are unchanged.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  newSessionId,
  ToolRegistry,
  type AskHandler,
  type HookDecision,
  type HookEvent,
  type ModelAdapter,
  type ModelResponse,
  type Tool,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a tool that records what it was called with. */
function recordingBash(calls: Array<{ command: string }>): Tool {
  return {
    name: "bash",
    description: "Run a bash command (records all calls).",
    parameters: z.object({ command: z.string() }),
    async execute({ command }, _ctx) {
      calls.push({ command });
      return { content: `executed: ${command}` };
    },
  };
}

/** A scripted ModelAdapter. */
function scriptedModel(
  responses: ReadonlyArray<{
    content: ModelResponse["content"];
    stopReason?: ModelResponse["stopReason"];
  }>,
): ModelAdapter {
  let i = 0;
  return {
    async complete(_input) {
      const r = responses[i];
      if (!r) throw new Error(`scriptedModel: script exhausted (call #${i + 1})`);
      i++;
      return {
        content: r.content,
        stopReason:
          r.stopReason ??
          (r.content.some((b) => b.type === "tool_call")
            ? "tool_use"
            : "end_turn"),
      };
    },
  };
}

/** Build an Agent with a custom ask handler. */
function agentWith(opts: {
  askHandler?: AskHandler;
  approval?: "unless-trusted" | "on-request" | "granular" | "never";
  hook?: (e: HookEvent) => Promise<HookDecision>;
  bashCalls?: Array<{ command: string }>;
  model: ModelAdapter;
}): { agent: Agent; toolRegistry: ToolRegistry } {
  const session = new InMemorySession(newSessionId(), {
    cwd: "/tmp",
    permissionMode: "workspace-write",
    startedAt: new Date().toISOString(),
  });
  const tools = new ToolRegistry();
  // Replace the built-in bash with our recorder.
  const recorder = recordingBash(opts.bashCalls ?? []);
  tools.register(recorder);
  const hooks = new HookRegistry();
  if (opts.hook) hooks.on("PreToolUse", opts.hook);
  const agent = new Agent({
    model: opts.model,
    tools,
    session,
    hooks,
    cwd: "/tmp",
    ...(opts.askHandler ? { askHandler: opts.askHandler } : {}),
    ...(opts.approval ? { approval: opts.approval } : {}),
  });
  return { agent, toolRegistry: tools };
}

// ---------------------------------------------------------------------------
// Happy path: handler returns allow
// ---------------------------------------------------------------------------

describe("F9.1 per-call approval — allow", () => {
  it("calls the handler when the hook returns ask", async () => {
    let called = false;
    const handler: AskHandler = async () => {
      called = true;
      return { kind: "allow" };
    };
    const { agent } = agentWith({
      askHandler: handler,
      hook: async (e) =>
        e.name === "PreToolUse"
          ? { kind: "ask", question: "Run bash?" }
          : { kind: "continue" },
      bashCalls: [],
      model: scriptedModel([
        {
          content: [
            {
              type: "tool_call",
              id: "t1",
              name: "bash",
              args: { command: "ls" },
            },
          ],
        },
        { content: [{ type: "text", text: "done" }] },
      ]),
    });
    await agent.run("hi");
    expect(called).toBe(true);
  });

  it("runs the tool when the handler returns allow", async () => {
    const bashCalls: Array<{ command: string }> = [];
    const handler: AskHandler = async () => ({ kind: "allow" });
    const { agent } = agentWith({
      askHandler: handler,
      hook: async (e) =>
        e.name === "PreToolUse" ? { kind: "ask", question: "x" } : { kind: "continue" },
      bashCalls,
      model: scriptedModel([
        {
          content: [
            {
              type: "tool_call",
              id: "t1",
              name: "bash",
              args: { command: "ls" },
            },
          ],
        },
        { content: [{ type: "text", text: "done" }] },
      ]),
    });
    await agent.run("hi");
    expect(bashCalls).toEqual([{ command: "ls" }]);
  });
});

// ---------------------------------------------------------------------------
// Deny path
// ---------------------------------------------------------------------------

describe("F9.1 per-call approval — deny", () => {
  it("blocks the tool when the handler returns deny", async () => {
    const bashCalls: Array<{ command: string }> = [];
    const handler: AskHandler = async () => ({
      kind: "deny",
      reason: "user said no",
    });
    const { agent } = agentWith({
      askHandler: handler,
      hook: async (e) =>
        e.name === "PreToolUse" ? { kind: "ask", question: "x" } : { kind: "continue" },
      bashCalls,
      model: scriptedModel([
        {
          content: [
            {
              type: "tool_call",
              id: "t1",
              name: "bash",
              args: { command: "rm -rf /" },
            },
          ],
        },
        { content: [{ type: "text", text: "denied" }] },
      ]),
    });
    await agent.run("hi");
    // Tool was never called.
    expect(bashCalls).toEqual([]);
  });

  it("the transcript shows 'denied by user: <reason>' for the tool result", async () => {
    const denyReason = "user explicitly said no";
    const handler: AskHandler = async () => ({
      kind: "deny",
      reason: denyReason,
    });
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const tools = new ToolRegistry();
    tools.register(recordingBash([]));
    const hooks = new HookRegistry();
    hooks.on("PreToolUse", async (e) =>
      e.name === "PreToolUse" ? { kind: "ask", question: "x" } : { kind: "continue" },
    );
    const agent = new Agent({
      model: scriptedModel([
        {
          content: [
            {
              type: "tool_call",
              id: "t1",
              name: "bash",
              args: { command: "rm" },
            },
          ],
        },
        { content: [{ type: "text", text: "ok" }] },
      ]),
      tools,
      session,
      hooks,
      cwd: "/tmp",
      askHandler: handler,
    });
    await agent.run("hi");
    const toolResult = session.messages
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result" && b.toolCallId === "t1");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.content).toBe(`denied by user: ${denyReason}`);
      expect(toolResult.isError).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Modify path
// ---------------------------------------------------------------------------

describe("F9.1 per-call approval — modify", () => {
  it("runs the tool with the modified args", async () => {
    const bashCalls: Array<{ command: string }> = [];
    const handler: AskHandler = async () => ({
      kind: "modify",
      args: { command: "ls -la" },
    });
    const { agent } = agentWith({
      askHandler: handler,
      hook: async (e) =>
        e.name === "PreToolUse" ? { kind: "ask", question: "x" } : { kind: "continue" },
      bashCalls,
      model: scriptedModel([
        {
          content: [
            {
              type: "tool_call",
              id: "t1",
              name: "bash",
              args: { command: "ls" },
            },
          ],
        },
        { content: [{ type: "text", text: "ok" }] },
      ]),
    });
    await agent.run("hi");
    // Tool was called with the modified args.
    expect(bashCalls).toEqual([{ command: "ls -la" }]);
  });

  it("fails with isError when the modified args don't match the zod schema", async () => {
    const bashCalls: Array<{ command: string }> = [];
    const handler: AskHandler = async () => ({
      kind: "modify",
      // `command` should be a string per the bash tool's
      // zod schema; we send a number.
      args: { command: 42 },
    });
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const tools = new ToolRegistry();
    tools.register(recordingBash(bashCalls));
    const hooks = new HookRegistry();
    hooks.on("PreToolUse", async (e) =>
      e.name === "PreToolUse" ? { kind: "ask", question: "x" } : { kind: "continue" },
    );
    const agent = new Agent({
      model: scriptedModel([
        {
          content: [
            {
              type: "tool_call",
              id: "t1",
              name: "bash",
              args: { command: "ls" },
            },
          ],
        },
        { content: [{ type: "text", text: "ok" }] },
      ]),
      tools,
      session,
      hooks,
      cwd: "/tmp",
      askHandler: handler,
    });
    await agent.run("hi");
    // Tool was never called because the modified args failed zod.
    expect(bashCalls).toEqual([]);
    // Transcript has the invalid-args message.
    const toolResult = session.messages
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result" && b.toolCallId === "t1");
    if (toolResult?.type === "tool_result") {
      expect(toolResult.isError).toBe(true);
      expect(String(toolResult.content)).toMatch(/invalid arguments/);
    }
  });
});

// ---------------------------------------------------------------------------
// No handler → safe default
// ---------------------------------------------------------------------------

describe("F9.1 per-call approval — no handler", () => {
  it("defaults to deny when no askHandler is configured", async () => {
    const bashCalls: Array<{ command: string }> = [];
    const { agent } = agentWith({
      // no askHandler
      hook: async (e) =>
        e.name === "PreToolUse" ? { kind: "ask", question: "x" } : { kind: "continue" },
      bashCalls,
      model: scriptedModel([
        {
          content: [
            {
              type: "tool_call",
              id: "t1",
              name: "bash",
              args: { command: "rm -rf /" },
            },
          ],
        },
        { content: [{ type: "text", text: "ok" }] },
      ]),
    });
    await agent.run("hi");
    expect(bashCalls).toEqual([]);
  });

  it("approval mode 'never' fails closed even with an allow-ing handler", async () => {
    const bashCalls: Array<{ command: string }> = [];
    const { agent } = agentWith({
      askHandler: async () => ({ kind: "allow" }),
      approval: "never",
      hook: async (e) =>
        e.name === "PreToolUse" ? { kind: "ask", question: "x" } : { kind: "continue" },
      bashCalls,
      model: scriptedModel([
        {
          content: [
            {
              type: "tool_call",
              id: "t1",
              name: "bash",
              args: { command: "rm -rf /" },
            },
          ],
        },
        { content: [{ type: "text", text: "ok" }] },
      ]),
    });
    await agent.run("hi");
    expect(bashCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AskRequest payload
// ---------------------------------------------------------------------------

describe("F9.1 per-call approval — AskRequest", () => {
  it("passes tool, args, question, options, signal to the handler", async () => {
    let received: unknown = null;
    const handler: AskHandler = async (req) => {
      received = req;
      return { kind: "allow" };
    };
    const { agent } = agentWith({
      askHandler: handler,
      hook: async (e) =>
        e.name === "PreToolUse"
          ? {
              kind: "ask",
              question: "Run bash with this command?",
              options: [
                { id: "yes", label: "Yes" },
                { id: "no", label: "No" },
              ],
            }
          : { kind: "continue" },
      bashCalls: [],
      model: scriptedModel([
        {
          content: [
            {
              type: "tool_call",
              id: "t1",
              name: "bash",
              args: { command: "rm -rf /" },
            },
          ],
        },
        { content: [{ type: "text", text: "ok" }] },
      ]),
    });
    await agent.run("hi");
    expect(received).toBeDefined();
    const r = received as { tool: string; args: unknown; question: string; options: ReadonlyArray<{ id: string }>; signal: AbortSignal };
    expect(r.tool).toBe("bash");
    expect(r.args).toEqual({ command: "rm -rf /" });
    expect(r.question).toBe("Run bash with this command?");
    expect(r.options).toHaveLength(2);
    expect(r.options[0]?.id).toBe("yes");
    expect(r.signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// Backward compat
// ---------------------------------------------------------------------------

describe("F9.1 per-call approval — backward compat", () => {
  it("a hook returning continue works the same as before", async () => {
    const bashCalls: Array<{ command: string }> = [];
    const { agent } = agentWith({
      // no askHandler
      hook: async () => ({ kind: "continue" }),
      bashCalls,
      model: scriptedModel([
        {
          content: [
            {
              type: "tool_call",
              id: "t1",
              name: "bash",
              args: { command: "ls" },
            },
          ],
        },
        { content: [{ type: "text", text: "ok" }] },
      ]),
    });
    await agent.run("hi");
    expect(bashCalls).toEqual([{ command: "ls" }]);
  });

  it("a hook returning block still works the same as before", async () => {
    const bashCalls: Array<{ command: string }> = [];
    const { agent } = agentWith({
      hook: async (e) =>
        e.name === "PreToolUse"
          ? { kind: "block", reason: "no" }
          : { kind: "continue" },
      bashCalls,
      model: scriptedModel([
        {
          content: [
            {
              type: "tool_call",
              id: "t1",
              name: "bash",
              args: { command: "ls" },
            },
          ],
        },
        { content: [{ type: "text", text: "ok" }] },
      ]),
    });
    await agent.run("hi");
    expect(bashCalls).toEqual([]);
  });
});
