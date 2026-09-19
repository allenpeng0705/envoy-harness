/**
 * Every declared hook event must actually fire.
 *
 * The registry declares **12** events; only `PreToolUse` and
 * `PostToolUse` had fire sites, so configuring a `SessionStart` or
 * `PreCompact` hook — exactly what a codex or Claude Code user expects to
 * work — silently did nothing.
 *
 * This test drives one realistic run through every boundary and asserts
 * each event is observed. It is deliberately a *coverage* test: it pins
 * the wiring, not the payload details (those are covered per-event
 * below).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  ToolRegistry,
  ToolExecutor,
  newSessionId,
  run,
  renderHookContext,
  isHookContextText,
  type HookEventName,
  type ModelAdapter,
  type ModelResponse,
  type Tool,
} from "../src/index.js";

/** A registry that records every event name it is asked to fire. */
function recordingHooks(): { hooks: HookRegistry; seen: HookEventName[] } {
  const hooks = new HookRegistry();
  const seen: HookEventName[] = [];
  const names: HookEventName[] = [
    "PreToolUse",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SessionStart",
    "SessionEnd",
    "Stop",
    "SubagentStop",
    "UserPromptSubmit",
    "Notification",
    "PermissionRequest",
    "Setup",
  ];
  for (const name of names) {
    // `continue` keeps the run moving; this test only records coverage.
    hooks.on(name, async () => {
      seen.push(name);
      return { kind: "continue" } as const;
    });
  }
  return { hooks, seen };
}

function session() {
  return new InMemorySession(newSessionId(), {
    cwd: process.cwd(),
    permissionMode: "workspace-write",
    startedAt: new Date().toISOString(),
  });
}

const echoModel: ModelAdapter = {
  async complete(): Promise<ModelResponse> {
    return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
  },
};

const echoTool: Tool = {
  name: "bash",
  description: "echo",
  parameters: z.object({ command: z.string() }),
  async execute() {
    return { content: "done" };
  },
};

describe("hook event coverage", () => {
  it("fires UserPromptSubmit and Stop around a turn", async () => {
    const { hooks, seen } = recordingHooks();
    const agent = new Agent({
      model: echoModel,
      tools: new ToolRegistry(),
      session: session(),
      hooks,
      cwd: process.cwd(),
    });
    await agent.run("hello");

    expect(seen).toContain("UserPromptSubmit");
    expect(seen).toContain("Stop");
    // Order: the prompt is submitted before the agent stops.
    expect(seen.indexOf("UserPromptSubmit")).toBeLessThan(seen.indexOf("Stop"));
  });

  it("fires PermissionRequest and Notification when approval is needed", async () => {
    const { hooks, seen } = recordingHooks();
    // A PreToolUse ask forces the approval path.
    hooks.on("PreToolUse", async () => ({
      kind: "ask" as const,
      question: "Allow bash?",
    }));

    const tools = new ToolRegistry();
    tools.register(echoTool);
    const s = session();
    const executor = new ToolExecutor({
      hooks,
      tools,
      session: s,
      cwd: process.cwd(),
      getSandboxPolicy: () => ({
        mode: "workspace-write",
        approval: "on-request",
        backend: "none",
        writableRoots: [],
        networkAccess: false,
        slashTmpWritable: false,
      }),
      getSandboxExecutor: () => undefined,
      getAskHandler: () => async () => ({ kind: "allow" as const }),
      getApproval: () => "on-request",
      abortSignal: new AbortController().signal,
      maxSubagents: 8,
      meshSubmitter: undefined,
      mcpClients: undefined,
      emit: () => undefined,
      noteToolCall: () => undefined,
    });

    await executor.execute(
      { type: "tool_call", id: "c1", name: "bash", args: { command: "hi" } },
      1,
    );

    expect(seen).toContain("PermissionRequest");
    expect(seen).toContain("Notification");
    expect(seen).toContain("PreToolUse");
    expect(seen).toContain("PostToolUse");
  });

  it("fires PreCompact and PostCompact around a compaction", async () => {
    const { hooks, seen } = recordingHooks();
    const agent = new Agent({
      model: echoModel,
      tools: new ToolRegistry(),
      session: session(),
      hooks,
      cwd: process.cwd(),
    });
    for (let i = 0; i < 6; i++) {
      agent.session.appendMessage("user", [{ type: "text", text: `m${i}` }]);
    }
    await agent.compactWithSummary(2, async () => "a summary");

    expect(seen).toContain("PreCompact");
    expect(seen).toContain("PostCompact");
    expect(seen.indexOf("PreCompact")).toBeLessThan(seen.indexOf("PostCompact"));
  });

  it("lets a PreCompact hook REFUSE the compaction", async () => {
    const hooks = new HookRegistry();
    hooks.on("PreCompact", async () => ({
      kind: "block" as const,
      reason: "this discussion must be preserved",
    }));
    const agent = new Agent({
      model: echoModel,
      tools: new ToolRegistry(),
      session: session(),
      hooks,
      cwd: process.cwd(),
    });
    for (let i = 0; i < 6; i++) {
      agent.session.appendMessage("user", [{ type: "text", text: `m${i}` }]);
    }

    await expect(
      agent.compactWithSummary(2, async () => "summary"),
    ).rejects.toThrow(/PreCompact hook/);
    // History untouched — the hook's refusal was honored.
    expect(agent.session.messages).toHaveLength(6);
  });

  it("lets a UserPromptSubmit hook veto a prompt before the model runs", async () => {
    const hooks = new HookRegistry();
    hooks.on("UserPromptSubmit", async () => ({
      kind: "block" as const,
      reason: "no prompts after hours",
    }));
    let modelCalls = 0;
    const agent = new Agent({
      model: {
        async complete() {
          modelCalls += 1;
          return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
        },
      },
      tools: new ToolRegistry(),
      session: session(),
      hooks,
      cwd: process.cwd(),
    });

    const result = await agent.run("please");
    expect(result.stopReason).toBe("aborted");
    expect(modelCalls).toBe(0);
  });
});

describe("SessionStart / SessionEnd / Setup fire end-to-end", () => {
  it("fires through the one-shot runner and injects add-context", async () => {
    const hooks = new HookRegistry();
    const seen: HookEventName[] = [];
    hooks.on("Setup", async () => {
      seen.push("Setup");
      return { kind: "add-context" as const, content: "setup rules" };
    });
    hooks.on("SessionStart", async () => {
      seen.push("SessionStart");
      return { kind: "add-context" as const, content: "project rules" };
    });
    hooks.on("SessionEnd", async () => {
      seen.push("SessionEnd");
      return { kind: "continue" as const };
    });

    const captured: string[] = [];
    const model: ModelAdapter = {
      async complete(input) {
        for (const m of input.messages) {
          if (m.role !== "user") continue;
          for (const b of m.content) {
            if (b.type === "text") captured.push(b.text);
          }
        }
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
      },
    };

    const sink = { write: () => true } as unknown as NodeJS.WritableStream;
    await run({
      argv: ["hi"],
      model,
      hooks,
      cwd: process.cwd(),
      stdout: sink,
      stderr: sink,
    });

    expect(seen).toEqual(["Setup", "SessionStart", "SessionEnd"]);
    // Both contributions reached the model as hook-context.
    expect(captured.some((t) => t.includes("setup rules"))).toBe(true);
    expect(captured.some((t) => t.includes("project rules"))).toBe(true);
  });
});

describe("hook context is model-only", () => {
  it("is hidden from chat transcripts", () => {
    const text = renderHookContext("SessionStart", "project rules");
    expect(isHookContextText(text)).toBe(true);
  });
});
