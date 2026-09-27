/**
 * Phase A/B — tasks[] multi-spawn, settlement notices, wait_agents.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  LocalMeshSubmitter,
  ToolRegistry,
  createLocalJobRegistry,
  defaultBuildSubagentFactory,
  makeTaskTool,
  makeWaitAgentsTool,
  newSessionId,
  type ModelAdapter,
  type ModelResponse,
  type SubagentResult,
  type ToolContext,
} from "../src/index.js";

function text(t: string): ModelResponse["content"][number] {
  return { type: "text", text: t };
}

function toolCall(
  id: string,
  name: string,
  args: unknown,
): ModelResponse["content"][number] {
  return { type: "tool_call", id, name, args };
}

function scriptedModel(
  responses: ReadonlyArray<ModelResponse["content"]>,
): ModelAdapter {
  let i = 0;
  return {
    async complete() {
      const content = responses[i++] ?? [text("done")];
      const stopReason = content.some((b) => b.type === "tool_call")
        ? "tool_use"
        : "end_turn";
      return { content, stopReason };
    },
  };
}

function childFactory(parentModel: ModelAdapter) {
  return defaultBuildSubagentFactory({
    model: parentModel,
    permissionMode: "read-only",
  });
}

function makeCtx(session?: InMemorySession): ToolContext {
  return {
    cwd: "/tmp",
    session:
      session ??
      new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
    abortSignal: new AbortController().signal,
  };
}

const baseTaskFields = {
  capability_tag: "research",
  cost_ceiling_usd: 0.5,
  deadline_ms: 30_000,
};

describe("task tasks[] batch", () => {
  it("spawns N foreground children and aggregates", async () => {
    const childModel = scriptedModel([[text("ok-a")], [text("ok-b")], [text("ok-c")]]);
    // Parent: one task with tasks[], then end.
    const parentModel = scriptedModel([
      [
        toolCall("t1", "task", {
          ...baseTaskFields,
          tasks: [
            { objective: "a" },
            { objective: "b" },
            { objective: "c" },
          ],
        }),
      ],
      [text("all done")],
    ]);
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: childFactory(childModel),
    });
    const tools = new ToolRegistry();
    const agent = new Agent({
      model: parentModel,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: process.cwd(),
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      meshSubmitter: submitter,
      maxSubagents: 8,
      maxParallelToolCalls: 4,
      systemPrompt: "test",
    });
    const result = await agent.run("go");
    expect(result.stopReason).toBe("end_turn");
    const toolMsg = agent.session.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const toolResult = toolMsg!.content.find((b) => b.type === "tool_result") as
      | { type: "tool_result"; content?: unknown }
      | undefined;
    expect(toolResult).toBeDefined();
    const payload = toolResult!.content as SubagentResult;
    expect(payload.status).toBe("completed");
    const joined = payload.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(joined).toContain("ok-a");
    expect(joined).toContain("ok-b");
    expect(joined).toContain("ok-c");
  });

  it("refuses when tasks.length > maxSubagents", async () => {
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: childFactory(scriptedModel([[text("x")]])),
    });
    const tool = makeTaskTool({
      submitter,
      maxSubagents: 2,
    });
    const out = await tool.execute(
      {
        ...baseTaskFields,
        tasks: [
          { objective: "1" },
          { objective: "2" },
          { objective: "3" },
        ],
      },
      makeCtx(),
    );
    expect(out.isError).toBe(true);
    expect(String(out.content)).toMatch(/maxSubagents/);
  });

  it("background tasks[] returns jobs list and settlement notice", async () => {
    const childModel = scriptedModel([[text("bg-one")], [text("bg-two")]]);
    const jobs = createLocalJobRegistry();
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: childFactory(childModel),
    });
    const notices: string[] = [];
    const tool = makeTaskTool({
      submitter,
      jobs,
      maxSubagents: 8,
      onBackgroundSettle: (info) => {
        notices.push(`${info.jobId}:${info.result.status}`);
      },
    });
    const session = new InMemorySession(newSessionId(), {
      cwd: process.cwd(),
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const out = await tool.execute(
      {
        ...baseTaskFields,
        run_in_background: true,
        tasks: [{ objective: "one" }, { objective: "two" }],
      },
      makeCtx(session),
    );
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(String(out.content)) as {
      jobs: Array<{ job_id: string; agent_id: string }>;
    };
    expect(parsed.jobs).toHaveLength(2);

    const wait = makeWaitAgentsTool({ submitter, jobs });
    const waited = await wait.execute(
      {
        job_ids: parsed.jobs.map((j) => j.job_id),
        timeout_ms: 10_000,
      },
      makeCtx(session),
    );
    const waitPayload = JSON.parse(String(waited.content)) as {
      results: Array<{ status: string }>;
    };
    expect(waitPayload.results).toHaveLength(2);
    expect(
      waitPayload.results.every(
        (r) => r.status === "completed" || r.status === "failed",
      ),
    ).toBe(true);
    // Settlement callbacks should have fired.
    expect(notices.length).toBe(2);
  });

  it("wait_agents times out unfinished jobs", async () => {
    const forever: ModelAdapter = {
      async complete({ signal }) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 60_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return { content: [text("never")], stopReason: "end_turn" };
      },
    };
    const jobs = createLocalJobRegistry();
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: childFactory(forever),
    });
    const tool = makeTaskTool({
      submitter,
      jobs,
      backgroundMode: "continuable",
    });
    const session = new InMemorySession(newSessionId(), {
      cwd: process.cwd(),
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const started = await tool.execute(
      {
        ...baseTaskFields,
        objective: "hang",
        run_in_background: true,
        background_mode: "continuable",
      },
      makeCtx(session),
    );
    const { job_id } = JSON.parse(String(started.content)) as {
      job_id: string;
    };
    const wait = makeWaitAgentsTool({ submitter, jobs });
    const waited = await wait.execute(
      { job_ids: [job_id], timeout_ms: 50 },
      makeCtx(session),
    );
    const payload = JSON.parse(String(waited.content)) as {
      results: Array<{ status: string }>;
    };
    expect(payload.results[0]?.status).toBe("timed_out");
    await jobs.dispose();
  });
});

describe("Agent settlement flush", () => {
  it("injects pendingSettlementNotices on the next run", async () => {
    const model = scriptedModel([[text("hello")], [text("after notice")]]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: process.cwd(),
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    agent.pendingSettlementNotices.push(
      "[system] Sub-agent settled: Background subagent a1 finished and will do no further work unless you send it more. (job=j1)\nIts closing message:\nok",
    );
    await agent.run("first");
    const texts = agent.session.messages
      .filter((m) => m.role === "user")
      .flatMap((m) =>
        m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text),
      );
    expect(texts.some((t) => t.includes("Sub-agent settled:"))).toBe(true);
    expect(agent.pendingSettlementNotices).toHaveLength(0);
  });

  it("flushes settlement notices mid-turn before the next model call", async () => {
    // Parent: tool call → then text. Between iterations we inject a notice.
    const parentModel = scriptedModel([
      [toolCall("t1", "echo", { text: "hi" })],
      [text("saw notice")],
    ]);
    const tools = new ToolRegistry();
    const agent = new Agent({
      model: parentModel,
      tools,
      session: new InMemorySession(newSessionId(), {
        cwd: process.cwd(),
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
    });
    tools.register({
      name: "echo",
      description: "echo",
      parameters: z.object({ text: z.string() }),
      async execute(args) {
        agent.enqueueSettlementNotice(
          "[system] Sub-agent settled: Background subagent mid finished and will do no further work unless you send it more. (job=jm)\nIts closing message:\ndone",
        );
        return { content: String(args.text) };
      },
    });
    await agent.run("go");
    const texts = agent.session.messages
      .filter((m) => m.role === "user")
      .flatMap((m) =>
        m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text),
      );
    expect(texts.some((t) => t.includes("Sub-agent settled:"))).toBe(true);
  });

  it("idle settlementFollowup runs a follow-up turn with the notice", async () => {
    const model = scriptedModel([[text("noted")]]);
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: process.cwd(),
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      onIdleSettlement: async (notice) => {
        await agent.run(notice);
        resolveDone();
      },
    });
    agent.enqueueSettlementNotice(
      "[system] Sub-agent settled: Background subagent idle1 finished and will do no further work unless you send it more. (job=ji)\nIts closing message:\nok",
    );
    await done;
    const texts = agent.session.messages
      .filter((m) => m.role === "user")
      .flatMap((m) =>
        m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text),
      );
    expect(texts.some((t) => t.includes("Sub-agent settled:"))).toBe(true);
    const assistant = agent.session.messages.filter((m) => m.role === "assistant");
    expect(assistant.length).toBeGreaterThan(0);
  });
});

describe("wait_agents abort vs timeout", () => {
  it("returns interrupted when parent abort fires during wait", async () => {
    const forever: ModelAdapter = {
      async complete({ signal }) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => resolve(), 60_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return { content: [text("never")], stopReason: "end_turn" };
      },
    };
    const jobs = createLocalJobRegistry();
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: childFactory(forever),
    });
    const tool = makeTaskTool({
      submitter,
      jobs,
      backgroundMode: "continuable",
    });
    const session = new InMemorySession(newSessionId(), {
      cwd: process.cwd(),
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const started = await tool.execute(
      {
        ...baseTaskFields,
        objective: "hang",
        run_in_background: true,
        background_mode: "continuable",
      },
      makeCtx(session),
    );
    const { job_id } = JSON.parse(String(started.content)) as {
      job_id: string;
    };
    const wait = makeWaitAgentsTool({ submitter, jobs });
    const ac = new AbortController();
    const ctx = { ...makeCtx(session), abortSignal: ac.signal };
    const pending = wait.execute(
      { job_ids: [job_id], timeout_ms: 30_000 },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const waited = await pending;
    const payload = JSON.parse(String(waited.content)) as {
      results: Array<{ status: string }>;
    };
    expect(payload.results[0]?.status).toBe("interrupted");
    await jobs.dispose();
  });
});

describe("mapBoundedParallel abort", () => {
  it("omits unstarted items and does not leave sparse holes", async () => {
    const { mapBoundedParallel } = await import("../src/subagent/bounded-parallel.js");
    const ac = new AbortController();
    let started = 0;
    const results = await mapBoundedParallel(
      [1, 2, 3, 4, 5],
      1,
      ac.signal,
      async (n) => {
        started += 1;
        if (started === 1) {
          ac.abort();
          await new Promise((r) => setTimeout(r, 10));
        }
        return n * 10;
      },
    );
    expect(results.every((r) => typeof r === "number")).toBe(true);
    expect(results.length).toBeLessThan(5);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

describe("wait_agents agent_ids abort", () => {
  it("returns interrupted when abort fires on agent waitSettle", async () => {
    const forever: ModelAdapter = {
      async complete({ signal }) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => resolve(), 60_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return { content: [text("never")], stopReason: "end_turn" };
      },
    };
    const jobs = createLocalJobRegistry();
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: childFactory(forever),
    });
    const tool = makeTaskTool({
      submitter,
      jobs,
      backgroundMode: "continuable",
    });
    const session = new InMemorySession(newSessionId(), {
      cwd: process.cwd(),
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const started = await tool.execute(
      {
        ...baseTaskFields,
        objective: "hang",
        run_in_background: true,
        background_mode: "continuable",
      },
      makeCtx(session),
    );
    const { agent_id } = JSON.parse(String(started.content)) as {
      agent_id: string;
    };
    const wait = makeWaitAgentsTool({ submitter, jobs });
    const ac = new AbortController();
    const pending = wait.execute(
      { agent_ids: [agent_id], timeout_ms: 30_000 },
      { ...makeCtx(session), abortSignal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const waited = await pending;
    const payload = JSON.parse(String(waited.content)) as {
      results: Array<{ status: string }>;
    };
    expect(payload.results[0]?.status).toBe("interrupted");
    await jobs.dispose();
  });
});

describe("tasks[] partial abort", () => {
  it("marks aggregate partial when some children never start", async () => {
    const childModel: ModelAdapter = {
      async complete({ signal }) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => resolve(), 200);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return { content: [text("ok")], stopReason: "end_turn" };
      },
    };
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: childFactory(childModel),
    });
    const tool = makeTaskTool({
      submitter,
      maxSubagents: 8,
      maxParallel: 1,
    });
    const ac = new AbortController();
    // Abort shortly after the first child starts so later tasks are skipped.
    setTimeout(() => ac.abort(), 30);
    const out = await tool.execute(
      {
        ...baseTaskFields,
        tasks: [
          { objective: "a" },
          { objective: "b" },
          { objective: "c" },
          { objective: "d" },
        ],
      },
      { ...makeCtx(), abortSignal: ac.signal },
    );
    expect(out.isError).toBeFalsy();
    const payload = out.content as SubagentResult;
    expect(payload.status).toBe("partial");
    const joined = payload.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(joined).toMatch(/\[aborted\] completed \d+\/4/);
  });
});
