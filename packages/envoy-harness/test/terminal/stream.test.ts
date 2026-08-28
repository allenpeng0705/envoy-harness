/**
 * Terminal tool output streaming via ToolContext.onToolOutput.
 */

import { describe, expect, it } from "vitest";

import { createLocalJobRegistry } from "../../src/jobs/index.js";
import {
  createFakeTerminalBackend,
  createTerminalSessionService,
  makeTerminalTools,
} from "../../src/terminal/index.js";
import type { Tool, ToolContext } from "../../src/tools/types.js";

function makeContext(
  sessionId: string,
  onToolOutput?: (stdout: string) => void,
): ToolContext {
  return {
    cwd: "/workspace",
    session: { id: sessionId } as ToolContext["session"],
    abortSignal: new AbortController().signal,
    ...(onToolOutput !== undefined ? { onToolOutput } : {}),
  };
}

function byName(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("terminal onToolOutput", () => {
  it("foreground terminal_send streams viewport text", async () => {
    const service = createTerminalSessionService();
    service.registerBackend(
      createFakeTerminalBackend({ sendDelayMs: 80, pid: 1 }),
    );
    const tools = makeTerminalTools(service);
    const chunks: string[] = [];
    const ctx = makeContext("sess-a", (stdout) => chunks.push(stdout));

    const opened = await byName(tools, "terminal_open").execute({}, ctx);
    const { sessionId } = JSON.parse(String(opened.content)) as {
      sessionId: string;
    };

    const sent = await byName(tools, "terminal_send").execute(
      { sessionId, text: "hello-term" },
      ctx,
    );
    expect(sent.isError).toBeUndefined();
    expect(chunks.join("")).toContain("hello-term");
  });

  it("terminal_read emits a one-shot preview", async () => {
    const service = createTerminalSessionService();
    service.registerBackend(createFakeTerminalBackend());
    const tools = makeTerminalTools(service);
    const chunks: string[] = [];
    const ctx = makeContext("sess-b", (stdout) => chunks.push(stdout));

    const opened = await byName(tools, "terminal_open").execute({}, ctx);
    const { sessionId } = JSON.parse(String(opened.content)) as {
      sessionId: string;
    };
    await byName(tools, "terminal_send").execute(
      { sessionId, text: "read-me" },
      ctx,
    );

    chunks.length = 0;
    await byName(tools, "terminal_read").execute({ sessionId }, ctx);
    expect(chunks.join("")).toContain("read-me");
  });

  it("background terminal_send streams while the job runs", async () => {
    const jobs = createLocalJobRegistry();
    const service = createTerminalSessionService();
    service.registerBackend(
      createFakeTerminalBackend({ sendDelayMs: 80, pid: 2 }),
    );
    const tools = makeTerminalTools(service, jobs);
    const chunks: string[] = [];
    const ctx = makeContext("sess-c", (stdout) => chunks.push(stdout));

    const opened = await byName(tools, "terminal_open").execute({}, ctx);
    const { sessionId } = JSON.parse(String(opened.content)) as {
      sessionId: string;
    };

    const sent = await byName(tools, "terminal_send").execute(
      { sessionId, text: "bg-term", run_in_background: true },
      ctx,
    );
    expect(sent.isError).toBeUndefined();
    const { jobId } = JSON.parse(String(sent.content)) as { jobId: string };
    await jobs.wait(jobId, 5_000, ctx.session.id);
    expect(chunks.join("")).toContain("bg-term");
    await jobs.dispose();
  });
});
