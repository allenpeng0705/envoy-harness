/**
 * Phase A / Item 5 — agent-level integration tests for
 * the `userQuestions` option. Covers the auto-wiring
 * in the `Agent` constructor:
 *
 * 1. `ask_user` tool is auto-registered when
 *    `userQuestions` is set.
 * 2. `ask_user` tool is NOT registered when
 *    `userQuestions` is absent (preserves existing
 *    behavior).
 * 3. `AskForApproval` shim is installed when
 *    `userQuestions` is set AND no `askHandler` is
 *    provided; hook's `kind: "ask"` goes through
 *    the service.
 * 4. Explicit `askHandler` wins over the shim (host
 *    takes precedence).
 * 5. `setUserQuestions` (live wire) installs /
 *    replaces the tool + shim.
 * 6. End-to-end: model emits an `ask_user` tool call;
 *    the tool result appears in the transcript.
 *
 * **Hermetic:** every test uses a fake
 * `UserQuestionService` (no real stdin / network / LLM).
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  newSessionId,
  ToolRegistry,
  type AskHandler,
  type HookEvent,
  type ModelAdapter,
  type ModelResponse,
} from "../src/index.js";
import type { Tool } from "../src/tools/types.js";
import type {
  UserQuestionAnswer,
  UserQuestionProvider,
  UserQuestionService,
} from "../src/interaction/user-questions.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A `UserQuestionService` that delegates to a fake
 *  provider returning the given answer. */
function buildFakeService(answer: UserQuestionAnswer): {
  service: UserQuestionService;
  calls: Parameters<UserQuestionProvider["ask"]>[0][];
} {
  const calls: Parameters<UserQuestionProvider["ask"]>[0][] = [];
  const askSpy = vi.fn(
    async (req: Parameters<UserQuestionProvider["ask"]>[0]): Promise<UserQuestionAnswer> => {
      calls.push(req);
      return answer;
    },
  );
  const provider: UserQuestionProvider = {
    name: "fake",
    ask: askSpy,
  };
  let current: UserQuestionProvider | undefined = provider;
  return {
    calls,
    service: {
      registerProvider(p: UserQuestionProvider): () => void {
        if (current !== undefined) {
          throw new Error("already registered");
        }
        current = p;
        return () => {
          if (current === p) current = undefined;
        };
      },
      hasProvider: () => current !== undefined,
      providerName: () => current?.name,
      async ask(req): Promise<UserQuestionAnswer> {
        return current!.ask(req);
      },
    },
  };
}

/** A scripted `ModelAdapter`. */
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
      if (!r) {
        throw new Error(`scriptedModel: script exhausted (call #${i + 1})`);
      }
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

/** Build a fresh `Session` for the test. */
function newSession(): InMemorySession {
  return new InMemorySession(newSessionId(), {
    cwd: "/tmp",
    permissionMode: "workspace-write",
    startedAt: new Date().toISOString(),
  });
}

/** Build an Agent with the user-question service. */
function agentWithUserQuestions(opts: {
  userQuestions: UserQuestionService | undefined;
  askHandler?: AskHandler;
  hook?: (e: HookEvent) => Promise<import("../src/types.js").HookDecision>;
  tools?: Tool[];
  model?: ModelAdapter;
}): { agent: Agent; toolRegistry: ToolRegistry } {
  const tools = new ToolRegistry();
  for (const t of opts.tools ?? []) tools.register(t);
  const hooks = new HookRegistry();
  if (opts.hook) hooks.on("PreToolUse", opts.hook);
  const agent = new Agent({
    model: opts.model ?? scriptedModel([{ content: [{ type: "text", text: "ok" }] }]),
    tools,
    session: newSession(),
    hooks,
    cwd: "/tmp",
    ...(opts.askHandler ? { askHandler: opts.askHandler } : {}),
    ...(opts.userQuestions ? { userQuestions: opts.userQuestions } : {}),
  });
  return { agent, toolRegistry: tools };
}

// ---------------------------------------------------------------------------
// 1. ask_user tool auto-registration
// ---------------------------------------------------------------------------

describe("Agent + userQuestions — ask_user tool auto-registration", () => {
  it("registers the ask_user tool when userQuestions is set", () => {
    const { service } = buildFakeService({ value: "x", cancelled: false });
    const { toolRegistry } = agentWithUserQuestions({
      userQuestions: service,
    });
    expect(toolRegistry.has("ask_user")).toBe(true);
  });

  it("does NOT register ask_user when userQuestions is absent", () => {
    const { toolRegistry } = agentWithUserQuestions({
      userQuestions: undefined,
    });
    expect(toolRegistry.has("ask_user")).toBe(false);
  });

  it("the auto-registered ask_user tool delegates to the service", async () => {
    const { service, calls } = buildFakeService({
      value: "yes",
      cancelled: false,
    });
    const { toolRegistry } = agentWithUserQuestions({
      userQuestions: service,
    });
    const askUser = toolRegistry.get("ask_user");
    expect(askUser).toBeDefined();
    const out = await askUser!.execute(
      { prompt: "Continue?" },
      {
        cwd: "/tmp",
        session: undefined as never,
        abortSignal: new AbortController().signal,
      },
    );
    expect(out.content).toBe("User answered: yes");
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. AskForApproval shim auto-wiring
// ---------------------------------------------------------------------------

describe("Agent + userQuestions — AskForApproval shim", () => {
  it("installs the shim when userQuestions is set and askHandler is absent", async () => {
    const { service, calls } = buildFakeService({
      value: "Yes",
      optionIndex: 0,
      cancelled: false,
    });
    // A hook that returns `kind: "ask"`. The shim
    // should be the recipient.
    const hook = async (): Promise<import("../src/types.js").HookDecision> => ({
      kind: "ask",
      question: "Allow bash to run `rm -rf /`?",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    });
    const bashCalls: string[] = [];
    const bash: Tool = {
      name: "bash",
      description: "test",
      parameters: z.object({ command: z.string() }),
      async execute({ command }) {
        bashCalls.push(command);
        return { content: `ran: ${command}` };
      },
    };
    const { agent } = agentWithUserQuestions({
      userQuestions: service,
      tools: [bash],
      hook,
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
    // The hook fired → the shim ran → the service
    // received the call → the user "said yes" (via
    // optionIndex 0) → the bash tool ran.
    expect(calls).toHaveLength(1);
    expect(bashCalls).toEqual(["rm -rf /"]);
  });

  it("explicit askHandler wins over the shim", async () => {
    const { service } = buildFakeService({
      value: "Yes",
      optionIndex: 0,
      cancelled: false,
    });
    let explicitHandlerCalled = false;
    const explicitHandler: AskHandler = async () => {
      explicitHandlerCalled = true;
      return { kind: "allow" };
    };
    const hook = async (): Promise<import("../src/types.js").HookDecision> => ({
      kind: "ask",
      question: "Allow?",
    });
    const { agent } = agentWithUserQuestions({
      userQuestions: service,
      askHandler: explicitHandler,
      hook,
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
    expect(explicitHandlerCalled).toBe(true);
  });

  it("preserves the existing deny default when no service is set and no askHandler is provided", async () => {
    const bashCalls: string[] = [];
    const bash: Tool = {
      name: "bash",
      description: "test",
      parameters: z.object({ command: z.string() }),
      async execute({ command }) {
        bashCalls.push(command);
        return { content: `ran: ${command}` };
      },
    };
    const hook = async (): Promise<import("../src/types.js").HookDecision> => ({
      kind: "ask",
      question: "Allow?",
    });
    const { agent } = agentWithUserQuestions({
      userQuestions: undefined,
      tools: [bash],
      hook,
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
    // No service, no handler → the agent's deny-by-
    // default kicks in; bash was not called.
    expect(bashCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. setUserQuestions live wiring
// ---------------------------------------------------------------------------

describe("Agent + userQuestions — setUserQuestions (live wire)", () => {
  it("installs the tool + shim on first call", () => {
    const { service } = buildFakeService({ value: "x", cancelled: false });
    const { agent, toolRegistry } = agentWithUserQuestions({
      userQuestions: undefined,
    });
    expect(toolRegistry.has("ask_user")).toBe(false);
    agent.setUserQuestions(service);
    expect(toolRegistry.has("ask_user")).toBe(true);
  });

  it("replaces the service: the new tool's execute uses the new service", async () => {
    const { service: s1, calls: c1 } = buildFakeService({
      value: "first",
      cancelled: false,
    });
    const { service: s2, calls: c2 } = buildFakeService({
      value: "second",
      cancelled: false,
    });
    const { agent, toolRegistry } = agentWithUserQuestions({
      userQuestions: s1,
    });
    agent.setUserQuestions(s2);
    const out = await toolRegistry.get("ask_user")!.execute(
      { prompt: "x" },
      {
        cwd: "/tmp",
        session: undefined as never,
        abortSignal: new AbortController().signal,
      },
    );
    expect(out.content).toBe("User answered: second");
    // s1 received no calls; s2 received the call.
    expect(c1).toHaveLength(0);
    expect(c2).toHaveLength(1);
  });

  it("unregistering (setUserQuestions(undefined)) removes the tool", () => {
    const { service } = buildFakeService({ value: "x", cancelled: false });
    const { agent, toolRegistry } = agentWithUserQuestions({
      userQuestions: service,
    });
    expect(toolRegistry.has("ask_user")).toBe(true);
    agent.setUserQuestions(undefined);
    expect(toolRegistry.has("ask_user")).toBe(false);
  });

  it("setUserQuestions does NOT overwrite an explicit askHandler", async () => {
    const { service } = buildFakeService({ value: "x", cancelled: false });
    let explicitHandlerCalled = false;
    const explicitHandler: AskHandler = async () => {
      explicitHandlerCalled = true;
      return { kind: "allow" };
    };
    const hook = async (): Promise<import("../src/types.js").HookDecision> => ({
      kind: "ask",
      question: "Allow?",
    });
    const { agent } = agentWithUserQuestions({
      userQuestions: undefined,
      askHandler: explicitHandler,
      hook,
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
    agent.setUserQuestions(service);
    await agent.run("hi");
    // Explicit handler was still called (host wins).
    expect(explicitHandlerCalled).toBe(true);
  });

  // Self-review regression test: previously, calling
  // `setUserQuestions(s2)` to replace `s1` updated the
  // `ask_user` tool but NOT the auto-installed shim
  // (the shim still closed over `s1`). The shim is now
  // tracked via `askHandlerIsShim` and replaced on
  // every service change. The new shim closes over the
  // new service.
  it("setUserQuestions REPLACES the shim with the new service's shim", async () => {
    const { service: s1, calls: c1 } = buildFakeService({
      value: "Yes",
      optionIndex: 0,
      cancelled: false,
    });
    const { service: s2, calls: c2 } = buildFakeService({
      value: "Yes",
      optionIndex: 0,
      cancelled: false,
    });
    const hook = async (): Promise<import("../src/types.js").HookDecision> => ({
      kind: "ask",
      question: "Allow?",
    });
    const bash: Tool = {
      name: "bash",
      description: "test",
      parameters: z.object({ command: z.string() }),
      async execute({ command }) {
        return { content: `ran: ${command}` };
      },
    };
    const { agent } = agentWithUserQuestions({
      userQuestions: s1,
      tools: [bash],
      hook,
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
    // Replace s1 with s2. The shim should now
    // close over s2 (s1 was replaced).
    agent.setUserQuestions(s2);
    await agent.run("hi");
    expect(c2.length).toBeGreaterThan(0);
    expect(c1.length).toBe(0);
  });

  // Self-review regression test: `setAskHandler(undefined)`
  // restores the default — if a service is registered,
  // the shim is RE-installed; if not, the handler
  // stays `undefined` (deny default).
  it("setAskHandler(undefined) restores the shim when a service is registered", async () => {
    const { service, calls } = buildFakeService({
      value: "Yes",
      optionIndex: 0,
      cancelled: false,
    });
    const hook = async (): Promise<import("../src/types.js").HookDecision> => ({
      kind: "ask",
      question: "Allow?",
    });
    const { agent } = agentWithUserQuestions({
      userQuestions: service,
      hook,
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
    // Initially: shim is installed (service set + no
    // explicit handler). Clearing the handler should
    // RE-INSTALL the shim (default behavior).
    agent.setAskHandler(undefined);
    await agent.run("hi");
    expect(calls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end: model emits ask_user
// ---------------------------------------------------------------------------

describe("Agent + userQuestions — end-to-end", () => {
  it("a model ask_user call surfaces the human's answer in the transcript", async () => {
    const { service, calls } = buildFakeService({
      value: "yes",
      cancelled: false,
    });
    // The model emits an `ask_user` tool call. The
    // tool delegates to the service. The result
    // appears in the transcript.
    const session = newSession();
    const tools = new ToolRegistry();
    const agent = new Agent({
      model: scriptedModel([
        {
          content: [
            {
              type: "tool_call",
              id: "t1",
              name: "ask_user",
              args: { prompt: "Continue?" },
            },
          ],
        },
        { content: [{ type: "text", text: "ok" }] },
      ]),
      tools,
      session,
      cwd: "/tmp",
      userQuestions: service,
    });
    await agent.run("hi");
    expect(calls).toHaveLength(1);
    // The tool result in the transcript.
    const toolResult = session.messages
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result" && b.toolCallId === "t1");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(String(toolResult.content)).toContain("User answered: yes");
      expect(toolResult.isError).toBe(false);
    }
  });

  it("'no-provider' answer surfaces the fall-through text + isError false", async () => {
    const { service } = buildFakeService({
      value: "",
      cancelled: true,
      cancelledReason: "no-provider",
    });
    const session = newSession();
    const tools = new ToolRegistry();
    const agent = new Agent({
      model: scriptedModel([
        {
          content: [
            {
              type: "tool_call",
              id: "t1",
              name: "ask_user",
              args: { prompt: "Continue?" },
            },
          ],
        },
        { content: [{ type: "text", text: "ok" }] },
      ]),
      tools,
      session,
      cwd: "/tmp",
      userQuestions: service,
    });
    await agent.run("hi");
    const toolResult = session.messages
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result" && b.toolCallId === "t1");
    if (toolResult?.type === "tool_result") {
      expect(String(toolResult.content)).toContain("no user channel");
      expect(toolResult.isError).toBe(false);
    }
  });
});
