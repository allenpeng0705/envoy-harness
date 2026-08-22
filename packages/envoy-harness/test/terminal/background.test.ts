/**
 * Phase C / Item 9 parity — `terminal_send(run_in_background: true)`
 * wired to the jobs registry (deepseek feature parity).
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
  signal: AbortSignal = new AbortController().signal,
): ToolContext {
  return {
    cwd: "/workspace",
    session: { id: sessionId } as ToolContext["session"],
    abortSignal: signal,
  };
}

function byName(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("terminal_send run_in_background (deepseek parity)", () => {
  it("returns a job id and settles the job with the send output", async () => {
    const service = createTerminalSessionService();
    service.registerBackend(createFakeTerminalBackend({ pid: 7 }));
    const jobs = createLocalJobRegistry();
    const tools = makeTerminalTools(service, jobs);
    const ctx = makeContext("sess-a");

    const opened = await byName(tools, "terminal_open").execute(
      { name: "main" },
      ctx,
    );
    const snap = JSON.parse(String(opened.content)) as { sessionId: string };

    const sent = await byName(tools, "terminal_send").execute(
      { sessionId: snap.sessionId, text: "echo hello", run_in_background: true },
      ctx,
    );
    expect(sent.isError).toBeUndefined();
    const bg = JSON.parse(String(sent.content)) as {
      kind: "background";
      jobId: string;
    };
    expect(bg.kind).toBe("background");
    expect(bg.jobId).toMatch(/^terminal-\d+$/);

    // The job settles (fake backend sendDelayMs=0 → immediate idle).
    const settled = await jobs.wait(bg.jobId, 2_000, "sess-a");
    expect(settled.status).toBe("completed");
    expect(settled.kind).toBe("terminal");

    await jobs.dispose();
    await service.dispose();
  });

  it("errors clearly when no job registry is wired", async () => {
    const service = createTerminalSessionService();
    service.registerBackend(createFakeTerminalBackend());
    const tools = makeTerminalTools(service); // no jobs
    const ctx = makeContext("sess-a");

    const opened = await byName(tools, "terminal_open").execute(
      { name: "main" },
      ctx,
    );
    const snap = JSON.parse(String(opened.content)) as { sessionId: string };
    const sent = await byName(tools, "terminal_send").execute(
      { sessionId: snap.sessionId, text: "ls", run_in_background: true },
      ctx,
    );
    expect(sent.isError).toBe(true);
    expect(String(sent.content)).toContain("requires a job registry");

    await service.dispose();
  });

  it("job_kill cancels the send and signals SIGINT to the session", async () => {
    const service = createTerminalSessionService();
    const signals: Array<{ sessionId: string; signal: string }> = [];
    const backend = createFakeTerminalBackend({ sendDelayMs: 10_000 });
    const origSignal = service.signal.bind(service);
    service.signal = async (owner, sessionId, signal) => {
      signals.push({ sessionId, signal });
      return origSignal(owner, sessionId, signal);
    };
    service.registerBackend(backend);
    const jobs = createLocalJobRegistry();
    const tools = makeTerminalTools(service, jobs);
    const ctx = makeContext("sess-a");

    const opened = await byName(tools, "terminal_open").execute(
      { name: "main" },
      ctx,
    );
    const snap = JSON.parse(String(opened.content)) as { sessionId: string };
    const sent = await byName(tools, "terminal_send").execute(
      { sessionId: snap.sessionId, text: "sleep 999", run_in_background: true },
      ctx,
    );
    const bg = JSON.parse(String(sent.content)) as { jobId: string };

    expect(jobs.kill(bg.jobId, "sess-a")).toBe("requested");
    expect(signals.some((s) => s.signal === "SIGINT")).toBe(true);

    await jobs.dispose();
    await service.dispose();
  });
});
