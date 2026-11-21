/**
 * Gap 10 — remoteCompact + compactAsync.
 */

import { describe, expect, it } from "vitest";

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

describe("compactRemote / compactAsync", () => {
  it("compactRemote uses adapter.remoteCompact", async () => {
    let called = false;
    const model: ModelAdapter = {
      async complete() {
        return { content: [text("ok")], stopReason: "end_turn" };
      },
      async remoteCompact() {
        called = true;
        return { summary: "REMOTE SUMMARY" };
      },
    };
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    for (let i = 0; i < 25; i++) {
      session.appendMessage("user", [{ type: "text", text: `m${i}` }]);
      session.appendMessage("assistant", [{ type: "text", text: `a${i}` }]);
    }
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    const before = agent.session.messages.length;
    await agent.compactRemote(4);
    expect(called).toBe(true);
    expect(agent.session.messages.length).toBeLessThan(before);
    expect(
      agent.session.events?.().some((e) => e.kind === "compact"),
    ).toBe(true);
  });

  it("compactRemote fails clearly without remoteCompact", async () => {
    const model: ModelAdapter = {
      async complete() {
        return { content: [text("ok")], stopReason: "end_turn" };
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
    });
    await expect(agent.compactRemote(4)).rejects.toThrow(/remoteCompact/);
  });

  it("compactAsync waits until idle during an active turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const model: ModelAdapter = {
      async complete() {
        await gate;
        return { content: [text("ok")], stopReason: "end_turn" };
      },
    };
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    for (let i = 0; i < 30; i++) {
      session.appendMessage("user", [{ type: "text", text: `m${i}` }]);
    }
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    const before = agent.session.messages.length;
    const runP = agent.run("busy");
    const compactP = agent.compactAsync(5);
    await new Promise((r) => setTimeout(r, 40));
    expect(agent.session.messages.length).toBeGreaterThanOrEqual(before);
    release();
    await runP;
    await compactP;
    expect(agent.session.messages.length).toBeLessThan(before);
    expect(
      (agent.session.events?.() ?? []).some((e) => e.kind === "compact"),
    ).toBe(true);
  });

  it("compactAsync runs after idle", async () => {
    const model: ModelAdapter = {
      async complete() {
        return { content: [text("ok")], stopReason: "end_turn" };
      },
    };
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    for (let i = 0; i < 30; i++) {
      session.appendMessage("user", [{ type: "text", text: `m${i}` }]);
    }
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    const before = agent.session.messages.length;
    await agent.compactAsync(5);
    expect(agent.session.messages.length).toBeLessThan(before);
  });
});
