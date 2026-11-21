/**
 * Gap 5 — collaboration alias tools.
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  LocalMeshSubmitter,
  ToolRegistry,
  createLocalJobRegistry,
  defaultBuildSubagentFactory,
  newSessionId,
  type ModelAdapter,
  type ModelResponse,
} from "../src/index.js";

function text(t: string): ModelResponse["content"][number] {
  return { type: "text", text: t };
}

describe("collaboration aliases", () => {
  it("registers spawn_agent / wait_agent / close_agent when continuable", () => {
    const childModel: ModelAdapter = {
      async complete() {
        return { content: [text("child")], stopReason: "end_turn" };
      },
    };
    const submitter = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({
        model: childModel,
        permissionMode: "read-only",
      }),
      workerPeerId: "local",
    });
    const agent = new Agent({
      model: childModel,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      meshSubmitter: submitter,
      jobRegistry: createLocalJobRegistry(),
    });
    expect(agent.tools.get("spawn_agent")).toBeDefined();
    expect(agent.tools.get("followup_task")).toBeDefined();
    expect(agent.tools.get("send_input")).toBeDefined();
    expect(agent.tools.get("wait_agent")).toBeDefined();
    expect(agent.tools.get("close_agent")).toBeDefined();
  });

  it("spawn_agent delegates to task (background)", async () => {
    const jobs = createLocalJobRegistry();
    const childModel: ModelAdapter = {
      async complete() {
        return { content: [text("spawned")], stopReason: "end_turn" };
      },
    };
    const submitter = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({
        model: childModel,
        permissionMode: "read-only",
      }),
      workerPeerId: "local",
    });
    const agent = new Agent({
      model: childModel,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      meshSubmitter: submitter,
      jobRegistry: jobs,
    });
    const tool = agent.tools.get("spawn_agent")!;
    const res = await tool.execute(
      {
        objective: "x",
        capability_tag: "research",
        cost_ceiling_usd: 0.2,
        deadline_ms: 10_000,
        run_in_background: true,
      },
      {
        cwd: "/tmp",
        session: agent.session,
        abortSignal: new AbortController().signal,
      },
    );
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(String(res.content)) as { agent_id: string };
    expect(parsed.agent_id.length).toBeGreaterThan(0);
    expect(
      (agent.session.events?.() ?? []).some((e) => e.kind === "child_spawn"),
    ).toBe(true);
    await jobs.dispose();
  });

  it("wait_agent with agent_id joins via wait_agents (not inbox)", async () => {
    const jobs = createLocalJobRegistry();
    const childModel: ModelAdapter = {
      async complete() {
        await new Promise((r) => setTimeout(r, 20));
        return { content: [text("joined")], stopReason: "end_turn" };
      },
    };
    const submitter = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({
        model: childModel,
        permissionMode: "read-only",
      }),
      workerPeerId: "local",
    });
    const agent = new Agent({
      model: childModel,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      meshSubmitter: submitter,
      jobRegistry: jobs,
    });
    const spawn = agent.tools.get("spawn_agent")!;
    const started = await spawn.execute(
      {
        objective: "x",
        capability_tag: "research",
        cost_ceiling_usd: 0.2,
        deadline_ms: 10_000,
        run_in_background: true,
      },
      {
        cwd: "/tmp",
        session: agent.session,
        abortSignal: new AbortController().signal,
      },
    );
    const { agent_id } = JSON.parse(String(started.content)) as {
      agent_id: string;
    };
    const wait = agent.tools.get("wait_agent")!;
    const res = await wait.execute(
      { agent_id, timeout_ms: 5_000 },
      {
        cwd: "/tmp",
        session: agent.session,
        abortSignal: new AbortController().signal,
      },
    );
    expect(res.isError).toBeUndefined();
    expect(String(res.content)).not.toContain('"wait":"inbox"');
    expect(String(res.content)).toContain("results");
    await jobs.dispose();
  });

  it("send_input delegates to send_message (queue delivery)", async () => {
    const jobs = createLocalJobRegistry();
    const childModel: ModelAdapter = {
      async complete() {
        return { content: [text("alive")], stopReason: "end_turn" };
      },
    };
    const submitter = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({
        model: childModel,
        permissionMode: "read-only",
      }),
      workerPeerId: "local",
    });
    const agent = new Agent({
      model: childModel,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      meshSubmitter: submitter,
      jobRegistry: jobs,
      subagentBackgroundMode: "continuable",
    });
    const spawn = agent.tools.get("spawn_agent")!;
    const started = await spawn.execute(
      {
        objective: "x",
        capability_tag: "research",
        cost_ceiling_usd: 0.2,
        deadline_ms: 10_000,
        run_in_background: true,
        background_mode: "continuable",
      },
      {
        cwd: "/tmp",
        session: agent.session,
        abortSignal: new AbortController().signal,
      },
    );
    const { agent_id } = JSON.parse(String(started.content)) as {
      agent_id: string;
    };
    await new Promise((r) => setTimeout(r, 30));
    const send = agent.tools.get("send_input")!;
    const res = await send.execute(
      { agent_id, message: "parked", delivery: "queue" },
      {
        cwd: "/tmp",
        session: agent.session,
        abortSignal: new AbortController().signal,
      },
    );
    expect(res.isError).toBeUndefined();
    expect(String(res.content)).toContain('"delivery":"queue"');
    expect(String(res.content)).toContain(agent_id);
    await jobs.dispose();
  });

  it("close_agent delegates to interrupt_agent", async () => {
    const jobs = createLocalJobRegistry();
    const childModel: ModelAdapter = {
      async complete() {
        await new Promise((r) => setTimeout(r, 200));
        return { content: [text("still going")], stopReason: "end_turn" };
      },
    };
    const submitter = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({
        model: childModel,
        permissionMode: "read-only",
      }),
      workerPeerId: "local",
    });
    const agent = new Agent({
      model: childModel,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      meshSubmitter: submitter,
      jobRegistry: jobs,
      subagentBackgroundMode: "continuable",
    });
    const spawn = agent.tools.get("spawn_agent")!;
    const started = await spawn.execute(
      {
        objective: "x",
        capability_tag: "research",
        cost_ceiling_usd: 0.2,
        deadline_ms: 10_000,
        run_in_background: true,
        background_mode: "continuable",
      },
      {
        cwd: "/tmp",
        session: agent.session,
        abortSignal: new AbortController().signal,
      },
    );
    const { agent_id } = JSON.parse(String(started.content)) as {
      agent_id: string;
    };
    const close = agent.tools.get("close_agent")!;
    const res = await close.execute(
      { agent_id, reason: "stop-now" },
      {
        cwd: "/tmp",
        session: agent.session,
        abortSignal: new AbortController().signal,
      },
    );
    expect(res.isError).toBeUndefined();
    expect(String(res.content)).toContain('"interrupted":true');
    expect(String(res.content)).toContain(agent_id);
    await jobs.dispose();
  });

  it("wait_agent without ids waits on parent inbox", async () => {
    const model: ModelAdapter = {
      async complete() {
        return { content: [text("ok")], stopReason: "end_turn" };
      },
    };
    const submitter = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({
        model,
        permissionMode: "read-only",
      }),
      workerPeerId: "local",
    });
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
      meshSubmitter: submitter,
      jobRegistry: createLocalJobRegistry(),
    });
    const tool = agent.tools.get("wait_agent")!;
    const pending = tool.execute(
      { timeout_ms: 2000 },
      {
        cwd: "/tmp",
        session: agent.session,
        abortSignal: new AbortController().signal,
      },
    );
    queueMicrotask(() => agent.inject("from host"));
    const res = await pending;
    expect(res.isError).toBeUndefined();
    expect(String(res.content)).toContain("from host");
    expect(String(res.content)).toContain('"wait":"inbox"');
  });
});
