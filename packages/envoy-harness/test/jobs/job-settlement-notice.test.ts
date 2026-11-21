/**
 * Bash job settle → parent settlement notice path.
 */

import { describe, expect, it } from "vitest";

import { z } from "zod";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  LocalMeshSubmitter,
  defaultBuildSubagentFactory,
  newSessionId,
  ToolRegistry,
  type ModelAdapter,
  type ModelResponse,
} from "../../src/index.js";
import { createLocalJobRegistry } from "../../src/jobs/index.js";
import type { JobHooks, JobOutcome } from "../../src/jobs/types.js";
import {
  JOB_SETTLEMENT_NOTICE_PREFIX,
  SETTLEMENT_NOTICE_PREFIX,
} from "../../src/subagent/settlement-notice.js";

function scriptedModel(
  responses: ReadonlyArray<ModelResponse["content"]>,
): ModelAdapter {
  let i = 0;
  return {
    async complete() {
      const content = responses[i++] ?? [{ type: "text", text: "done" }];
      return { content, stopReason: "end_turn" as const };
    },
  };
}

function controllableJob(): {
  hooks: JobHooks;
  settle: (outcome: JobOutcome) => void;
} {
  let resolveDone!: (o: JobOutcome) => void;
  const done = new Promise<JobOutcome>((resolve) => {
    resolveDone = resolve;
  });
  return {
    settle: (o) => resolveDone(o),
    hooks: {
      cancel() {},
      done,
      readOutput: () => "",
    },
  };
}

describe("bash job settlement notices", () => {
  it("enqueues a notice when a bash job owned by the agent completes", async () => {
    const jobs = createLocalJobRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model: scriptedModel([[{ type: "text", text: "idle" }]]),
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      systemPrompt: "test",
      jobRegistry: jobs,
    });

    const c = controllableJob();
    const id = jobs.start({
      kind: "bash",
      label: "echo-hi",
      owner: session.id,
      run: () => c.hooks,
    });

    expect(agent.pendingSettlementNotices).toHaveLength(0);
    c.settle({ status: "completed", output: "hi" });
    // onJobDone is sync from settle path — allow microtask drain.
    await Promise.resolve();
    await Promise.resolve();

    expect(agent.pendingSettlementNotices.length).toBeGreaterThanOrEqual(1);
    const notice = agent.pendingSettlementNotices.join("\n");
    expect(notice).toContain(JOB_SETTLEMENT_NOTICE_PREFIX);
    expect(notice).toContain(id);
    expect(notice).toContain("completed");

    await jobs.dispose();
  });

  it("skips subagent kind (already notified via onBackgroundSettle)", async () => {
    const jobs = createLocalJobRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model: scriptedModel([[{ type: "text", text: "idle" }]]),
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      systemPrompt: "test",
      jobRegistry: jobs,
    });

    const c = controllableJob();
    jobs.start({
      kind: "subagent",
      label: "child",
      owner: session.id,
      run: () => c.hooks,
    });
    c.settle({ status: "completed", output: "ok" });
    await Promise.resolve();
    await Promise.resolve();

    expect(
      agent.pendingSettlementNotices.some((n) =>
        n.includes(JOB_SETTLEMENT_NOTICE_PREFIX),
      ),
    ).toBe(false);

    await jobs.dispose();
  });

  it("does not enqueue after abort/dispose", async () => {
    const jobs = createLocalJobRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model: scriptedModel([[{ type: "text", text: "idle" }]]),
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      systemPrompt: "test",
      jobRegistry: jobs,
    });

    const c = controllableJob();
    jobs.start({
      kind: "bash",
      label: "late",
      owner: session.id,
      run: () => c.hooks,
    });
    agent.abort("teardown");
    c.settle({ status: "completed", output: "too late" });
    await Promise.resolve();
    await Promise.resolve();

    expect(agent.pendingSettlementNotices).toHaveLength(0);
    await jobs.dispose();
  });

  it("ignores jobs owned by another session", async () => {
    const jobs = createLocalJobRegistry();
    const sessionA = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const sessionB = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const agentA = new Agent({
      model: scriptedModel([[{ type: "text", text: "idle" }]]),
      tools: new ToolRegistry(),
      session: sessionA,
      hooks: new HookRegistry(),
      systemPrompt: "test",
      jobRegistry: jobs,
    });

    const c = controllableJob();
    jobs.start({
      kind: "bash",
      label: "other-owner",
      owner: sessionB.id,
      run: () => c.hooks,
    });
    c.settle({ status: "completed", output: "ok" });
    await Promise.resolve();
    await Promise.resolve();

    expect(agentA.pendingSettlementNotices).toHaveLength(0);
    await jobs.dispose();
  });

  it("abort unsubscribes one agent without silencing peers on the same registry", async () => {
    const jobs = createLocalJobRegistry();
    const sessionA = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const sessionB = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const agentA = new Agent({
      model: scriptedModel([[{ type: "text", text: "idle" }]]),
      tools: new ToolRegistry(),
      session: sessionA,
      hooks: new HookRegistry(),
      systemPrompt: "test",
      jobRegistry: jobs,
    });
    const agentB = new Agent({
      model: scriptedModel([[{ type: "text", text: "idle" }]]),
      tools: new ToolRegistry(),
      session: sessionB,
      hooks: new HookRegistry(),
      systemPrompt: "test",
      jobRegistry: jobs,
    });

    agentA.abort("gone");
    const c = controllableJob();
    const id = jobs.start({
      kind: "bash",
      label: "b-job",
      owner: sessionB.id,
      run: () => c.hooks,
    });
    c.settle({ status: "completed", output: "ok" });
    await Promise.resolve();
    await Promise.resolve();

    expect(agentA.pendingSettlementNotices).toHaveLength(0);
    expect(
      agentB.pendingSettlementNotices.some(
        (n) => n.includes(JOB_SETTLEMENT_NOTICE_PREFIX) && n.includes(id),
      ),
    ).toBe(true);
    await jobs.dispose();
  });

  it("job_wait settle still enqueues a notice (no wait suppress)", async () => {
    const jobs = createLocalJobRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model: scriptedModel([[{ type: "text", text: "idle" }]]),
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      systemPrompt: "test",
      jobRegistry: jobs,
    });
    const { makeJobTools } = await import("../../src/jobs/tools.js");
    const tools = makeJobTools(jobs);
    const jobWait = tools.find((t) => t.name === "job_wait")!;

    const c = controllableJob();
    const id = jobs.start({
      kind: "bash",
      label: "waited-via-job-wait",
      owner: session.id,
      run: () => c.hooks,
    });
    const pending = jobWait.execute(
      { id, timeoutMs: 5_000 },
      {
        cwd: "/tmp",
        session,
        abortSignal: new AbortController().signal,
      },
    );
    c.settle({ status: "completed", output: "done" });
    await pending;
    await Promise.resolve();
    await Promise.resolve();

    expect(
      agent.pendingSettlementNotices.some((n) =>
        n.includes(JOB_SETTLEMENT_NOTICE_PREFIX),
      ),
    ).toBe(true);
    await jobs.dispose();
  });

  it("job_output without wait still enqueues a settle notice", async () => {
    const jobs = createLocalJobRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model: scriptedModel([[{ type: "text", text: "idle" }]]),
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      systemPrompt: "test",
      jobRegistry: jobs,
    });
    const { makeJobTools } = await import("../../src/jobs/tools.js");
    const tools = makeJobTools(jobs);
    const jobOutput = tools.find((t) => t.name === "job_output")!;

    const c = controllableJob();
    const id = jobs.start({
      kind: "bash",
      label: "no-wait",
      owner: session.id,
      run: () => c.hooks,
    });
    await jobOutput.execute(
      { id, wait: false },
      {
        cwd: "/tmp",
        session,
        abortSignal: new AbortController().signal,
      },
    );
    c.settle({ status: "completed", output: "done" });
    await Promise.resolve();
    await Promise.resolve();

    expect(
      agent.pendingSettlementNotices.some((n) =>
        n.includes(JOB_SETTLEMENT_NOTICE_PREFIX),
      ),
    ).toBe(true);
    await jobs.dispose();
  });

  it("queues mid-turn instead of auto-running when a turn is active", async () => {
    let completes = 0;
    const model: ModelAdapter = {
      async complete() {
        completes += 1;
        if (completes === 1) {
          return {
            content: [
              {
                type: "tool_call",
                id: "t1",
                name: "settle_now",
                args: {},
              },
            ],
            stopReason: "tool_use",
          };
        }
        return {
          content: [{ type: "text", text: "after" }],
          stopReason: "end_turn",
        };
      },
    };
    const jobs = createLocalJobRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const tools = new ToolRegistry();
    const agent = new Agent({
      model,
      tools,
      session,
      hooks: new HookRegistry(),
      systemPrompt: "test",
      jobRegistry: jobs,
      settlementFollowup: true,
    });
    tools.register({
      name: "settle_now",
      description: "start and settle a bash job",
      parameters: z.object({}),
      async execute() {
        const c = controllableJob();
        jobs.start({
          kind: "bash",
          label: "mid",
          owner: session.id,
          run: () => c.hooks,
        });
        c.settle({ status: "completed", output: "mid" });
        return { content: "settled" };
      },
    });

    await agent.run("go");
    const userTexts = session.messages
      .filter((m) => m.role === "user")
      .flatMap((m) =>
        m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text),
      );
    expect(userTexts.some((t) => t.includes(JOB_SETTLEMENT_NOTICE_PREFIX))).toBe(
      true,
    );
    // Primary turn + no idle followup for the mid-turn notice (flushed in-turn).
    expect(completes).toBe(2);
    await jobs.dispose();
  });
});

describe("Agent onBackgroundSettle wiring", () => {
  it("enqueues a Sub-agent settled notice when a background child finishes", async () => {
    const jobs = createLocalJobRegistry();
    const childModel: ModelAdapter = {
      async complete() {
        return {
          content: [{ type: "text", text: "child-done" }],
          stopReason: "end_turn",
        };
      },
    };
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: defaultBuildSubagentFactory({ model: childModel }),
    });
    // Parent: one background task, then end. Stay idle so settle queues.
    let parentCalls = 0;
    const parentModel: ModelAdapter = {
      async complete() {
        parentCalls += 1;
        if (parentCalls === 1) {
          return {
            content: [
              {
                type: "tool_call",
                id: "t1",
                name: "task",
                args: {
                  objective: "do it",
                  capability_tag: "research",
                  cost_ceiling_usd: 0.5,
                  deadline_ms: 30_000,
                  run_in_background: true,
                },
              },
            ],
            stopReason: "tool_use",
          };
        }
        return {
          content: [{ type: "text", text: "parent idle" }],
          stopReason: "end_turn",
        };
      },
    };
    const agent = new Agent({
      model: parentModel,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "test",
      meshSubmitter: submitter,
      jobRegistry: jobs,
      // Queue only — do not auto-run followup so we can inspect the notice.
      settlementFollowup: false,
    });

    await agent.run("spawn");
    // Child may settle mid-turn (flushed into session) or after idle (queued).
    await until(() => {
      const pending = agent.pendingSettlementNotices.join("\n");
      const flushed = agent.session.messages
        .filter((m) => m.role === "user")
        .flatMap((m) =>
          m.content
            .filter(
              (b): b is { type: "text"; text: string } => b.type === "text",
            )
            .map((b) => b.text),
        )
        .join("\n");
      return (
        pending.includes(SETTLEMENT_NOTICE_PREFIX) ||
        flushed.includes(SETTLEMENT_NOTICE_PREFIX)
      );
    }, 3_000);

    const allText = [
      ...agent.pendingSettlementNotices,
      ...agent.session.messages
        .filter((m) => m.role === "user")
        .flatMap((m) =>
          m.content
            .filter(
              (b): b is { type: "text"; text: string } => b.type === "text",
            )
            .map((b) => b.text),
        ),
    ].join("\n");
    expect(allText).toContain(SETTLEMENT_NOTICE_PREFIX);
    expect(allText).toContain("child-done");
    // Subagent kind must not also produce a Job settled notice.
    expect(allText).not.toContain(JOB_SETTLEMENT_NOTICE_PREFIX);

    await jobs.dispose();
  });
});

async function until(
  cond: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for settlement notice");
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}
