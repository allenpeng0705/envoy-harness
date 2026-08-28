/**
 * Phase C / Item 9 — terminal tools tests (hermetic).
 */

import { describe, expect, it } from "vitest";

import {
  createFakeTerminalBackend,
  createTerminalSessionService,
  makeTerminalTools,
  registerTerminalTools,
} from "../../src/terminal/index.js";
import type { Tool, ToolContext } from "../../src/tools/types.js";

function makeContext(
  sessionId: string,
  cwd = "/workspace",
  signal: AbortSignal = new AbortController().signal,
): ToolContext {
  return {
    cwd,
    session: { id: sessionId } as ToolContext["session"],
    abortSignal: signal,
  };
}

function byName(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("makeTerminalTools", () => {
  it("happy path: open → send → read → list → close", async () => {
    const service = createTerminalSessionService();
    service.registerBackend(createFakeTerminalBackend({ pid: 7 }));
    const tools = makeTerminalTools(service);
    const ctx = makeContext("sess-a");

    const opened = await byName(tools, "terminal_open").execute(
      { name: "main" },
      ctx,
    );
    expect(opened.isError).toBeUndefined();
    const snap = JSON.parse(String(opened.content)) as {
      sessionId: string;
      type: string;
      name: string;
      cwd?: string;
      motd: string;
      pid: number;
    };
    expect(snap).toMatchObject({
      sessionId: "pty-1",
      type: "fake",
      name: "main",
      pid: 7,
      motd: "fake terminal ready",
    });

    const sent = await byName(tools, "terminal_send").execute(
      { sessionId: snap.sessionId, text: "echo hi" },
      ctx,
    );
    expect(sent.isError).toBeUndefined();
    const sendBody = JSON.parse(String(sent.content)) as {
      kind: string;
      viewport: string;
      waitReason: string;
    };
    expect(sendBody).toMatchObject({
      kind: "foreground",
      viewport: "echo hi\n",
      waitReason: "inferred_idle",
    });

    const read = await byName(tools, "terminal_read").execute(
      { sessionId: snap.sessionId },
      ctx,
    );
    expect(JSON.parse(String(read.content))).toMatchObject({
      text: "echo hi\n",
      totalLines: 2,
      truncated: false,
    });

    const listed = await byName(tools, "terminal_list").execute({}, ctx);
    expect(JSON.parse(String(listed.content))).toMatchObject({
      sessions: [{ sessionId: "pty-1", name: "main", type: "fake" }],
    });

    const closed = await byName(tools, "terminal_close").execute(
      { sessionId: snap.sessionId },
      ctx,
    );
    expect(JSON.parse(String(closed.content))).toEqual({
      sessionId: "pty-1",
      outcome: "closed",
    });
    expect(
      JSON.parse(
        String(
          (await byName(tools, "terminal_list").execute({}, ctx)).content,
        ),
      ),
    ).toEqual({ sessions: [] });

    await service.dispose();
  });

  it("returns isError for foreign-session access", async () => {
    const service = createTerminalSessionService();
    service.registerBackend(createFakeTerminalBackend());
    const tools = makeTerminalTools(service);
    const alice = makeContext("alice");
    const bob = makeContext("bob");

    const opened = await byName(tools, "terminal_open").execute({}, alice);
    const sessionId = (
      JSON.parse(String(opened.content)) as { sessionId: string }
    ).sessionId;

    const foreign = await byName(tools, "terminal_read").execute(
      { sessionId },
      bob,
    );
    expect(foreign.isError).toBe(true);
    expect(String(foreign.content)).toContain("FOREIGN_SESSION");

    await service.dispose();
  });

  it("uses ctx.cwd when open omits cwd", async () => {
    const service = createTerminalSessionService();
    let seenCwd: string | undefined;
    service.registerBackend(
      createFakeTerminalBackend({
        onSpawn(spec) {
          seenCwd = spec.cwd;
        },
      }),
    );
    const tools = makeTerminalTools(service);
    await byName(tools, "terminal_open").execute(
      {},
      makeContext("s1", "/from-ctx"),
    );
    expect(seenCwd).toBe("/from-ctx");
    await service.dispose();
  });

  it("registerTerminalTools registers all six tools", () => {
    const service = createTerminalSessionService();
    const registered: string[] = [];
    registerTerminalTools(
      {
        register(tool) {
          registered.push(tool.name);
        },
      },
      service,
    );
    expect(registered).toEqual([
      "terminal_open",
      "terminal_send",
      "terminal_read",
      "terminal_signal",
      "terminal_close",
      "terminal_list",
    ]);
  });
});
