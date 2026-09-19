import { describe, expect, it } from "vitest";

import type { Agent } from "../../src/agent.js";
import { createAgentSessionBackend } from "../../src/protocol/agent-backend.js";
import { slashLineOf } from "../../src/protocol/slash-dispatch.js";

function slashAgent(): Agent {
  return {
    cwd: "/tmp/work",
    getPermissionMode: () => "read-only",
    getPermissionPreset: () => undefined,
    getCost: () => ({ costUsd: 0, inputTokens: 0, outputTokens: 0 }),
    getMeshSubmitter: () => undefined,
    setPermissionMode() {},
    setAskHandler() {},
    clearSession() {},
    async run() {
      throw new Error("the model should not see a slash command");
    },
  } as unknown as Agent;
}

describe("ACP slash commands", () => {
  it("treats a leading slash as a command and leaves ordinary text alone", () => {
    expect(slashLineOf({ text: "  /help  " })).toBe("/help");
    expect(slashLineOf({ text: "please /help" })).toBeUndefined();
    expect(
      slashLineOf({
        content: [{ type: "image", mimeType: "image/png", data: "aa" }],
      }),
    ).toBeUndefined();
    expect(
      slashLineOf({
        content: [
          { type: "text", text: "/help" },
          { type: "text", text: "and this" },
        ],
      }),
    ).toBeUndefined();
  });

  it("runs /help on the session and does not call the model", async () => {
    const backend = createAgentSessionBackend({
      createAgent: () => slashAgent(),
    });
    const { sessionId } = await backend.createSession({ cwd: "/tmp/work" });
    const updates: string[] = [];
    const result = await backend.prompt({
      sessionId,
      prompt: { text: "/help" },
      signal: new AbortController().signal,
      requestPermission: async () => "deny",
      onUpdate: (msg) => updates.push(msg.text),
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.messages[0]?.text).toContain("/compact");
    expect(updates[0]).toContain("/help");
  });

  it("keeps a sandbox change for the next slash command", async () => {
    const backend = createAgentSessionBackend({
      createAgent: () => slashAgent(),
    });
    const { sessionId } = await backend.createSession({});
    const set = await backend.prompt({
      sessionId,
      prompt: { text: "/sandbox workspace-write" },
      signal: new AbortController().signal,
      requestPermission: async () => "deny",
    });
    expect(set.messages[0]?.text).toContain("workspace-write");
    const shown = await backend.prompt({
      sessionId,
      prompt: { text: "/sandbox" },
      signal: new AbortController().signal,
      requestPermission: async () => "deny",
    });
    expect(shown.messages[0]?.text).toContain("current sandbox: workspace-write");
  });

  it("answers an unknown command the way the REPL does", async () => {
    const backend = createAgentSessionBackend({
      createAgent: () => slashAgent(),
    });
    const { sessionId } = await backend.createSession({});
    const result = await backend.prompt({
      sessionId,
      prompt: { text: "/not-a-command" },
      signal: new AbortController().signal,
      requestPermission: async () => "deny",
    });
    expect(result.messages[0]?.text).toBe(
      "unknown command: /not-a-command\ntype /help for a list of commands",
    );
  });

  it("does not exit the process on /quit", async () => {
    const backend = createAgentSessionBackend({
      createAgent: () => slashAgent(),
    });
    const { sessionId } = await backend.createSession({});
    const result = await backend.prompt({
      sessionId,
      prompt: { text: "/quit" },
      signal: new AbortController().signal,
      requestPermission: async () => "deny",
    });
    expect(result.messages[0]?.text).toContain("stays open");
  });
});
