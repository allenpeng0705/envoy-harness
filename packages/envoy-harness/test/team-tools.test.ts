/**
 * Gap 8 — team_* model tools + TeamJobRegistry.
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  TeamJobRegistry,
  ToolRegistry,
  newSessionId,
  type ModelAdapter,
  type ModelResponse,
} from "../src/index.js";

function text(t: string): ModelResponse["content"][number] {
  return { type: "text", text: t };
}

describe("team tools", () => {
  it("team_start updates the board and returns agent text", async () => {
    const model: ModelAdapter = {
      async complete() {
        return { content: [text("done-by-agent")], stopReason: "end_turn" };
      },
    };
    const registry = new TeamJobRegistry();
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
      teamJobRegistry: registry,
    });
    const tool = agent.tools.get("team_start")!;
    const res = await tool.execute(
      {
        config: {
          name: "demo",
          agents: [
            {
              id: "a",
              role: "worker",
              objective: "say hi",
              dependsOn: [],
            },
          ],
        },
      },
      {
        cwd: "/tmp",
        session: agent.session,
        abortSignal: new AbortController().signal,
      },
    );
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(String(res.content)) as {
      job_id: string;
      status: string;
      agents: Array<{ text: string }>;
    };
    expect(parsed.status).toBe("completed");
    expect(parsed.agents[0]?.text).toContain("done-by-agent");
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.status).toBe("completed");
  });

  it("team_jobs lists board and team_status errors on unknown id", async () => {
    const model: ModelAdapter = {
      async complete() {
        return { content: [text("done-by-agent")], stopReason: "end_turn" };
      },
    };
    const registry = new TeamJobRegistry();
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
      teamJobRegistry: registry,
    });
    const start = agent.tools.get("team_start")!;
    const started = await start.execute(
      {
        config: {
          name: "demo2",
          agents: [
            { id: "a", role: "worker", objective: "x", dependsOn: [] },
          ],
        },
      },
      {
        cwd: "/tmp",
        session: agent.session,
        abortSignal: new AbortController().signal,
      },
    );
    const { job_id } = JSON.parse(String(started.content)) as {
      job_id: string;
    };
    const jobs = await agent.tools.get("team_jobs")!.execute(
      {},
      {
        cwd: "/tmp",
        session: agent.session,
        abortSignal: new AbortController().signal,
      },
    );
    expect(String(jobs.content)).toContain(job_id);
    const bad = await agent.tools.get("team_status")!.execute(
      { job_id: "missing" },
      {
        cwd: "/tmp",
        session: agent.session,
        abortSignal: new AbortController().signal,
      },
    );
    expect(bad.isError).toBe(true);
    const ok = await agent.tools.get("team_status")!.execute(
      { job_id },
      {
        cwd: "/tmp",
        session: agent.session,
        abortSignal: new AbortController().signal,
      },
    );
    expect(ok.isError).toBeUndefined();
    expect(String(ok.content)).toContain(job_id);
  });

  it("does not register team tools without teamJobRegistry", () => {
    const agent = new Agent({
      model: {
        async complete() {
          return { content: [text("ok")], stopReason: "end_turn" };
        },
      },
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    expect(agent.tools.get("team_start")).toBeUndefined();
  });
});
