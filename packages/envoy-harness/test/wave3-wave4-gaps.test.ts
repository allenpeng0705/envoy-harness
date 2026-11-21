/**
 * Wave 3–4 gap coverage: mailbox, schedule, goals, present,
 * workflow budgets, loopback remote, handshake backoff, fencing.
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  AgentMailbox,
  HookRegistry,
  InMemorySession,
  LocalMeshSubmitter,
  ToolRegistry,
  createGoalStore,
  createLocalJobRegistry,
  createLoopbackRemoteJobTransport,
  createScheduleStore,
  defaultBuildSubagentFactory,
  formatRemoteJobRef,
  makeGoalTools,
  makePresentTool,
  makeScheduleTools,
  newSessionId,
  parallel,
  withHandshakeBackoff,
  type ModelAdapter,
  type SubagentResult,
  type ToolContext,
} from "../src/index.js";

function makeCtx(cwd = "/tmp"): ToolContext {
  return {
    cwd,
    session: new InMemorySession(newSessionId(), {
      cwd,
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    }),
    abortSignal: new AbortController().signal,
  };
}

describe("mailbox V2", () => {
  it("delivers and claims in order", () => {
    const mb = new AgentMailbox();
    mb.deliver("child-a", "hello");
    mb.deliver("child-b", "world");
    const claimed = mb.claimAll();
    expect(claimed).toHaveLength(2);
    expect(mb.claimAll()).toHaveLength(0);
  });
});

describe("schedule → inbox", () => {
  it("claims due once tasks and Agent.tickSchedules injects", async () => {
    const store = createScheduleStore();
    const past = new Date(Date.now() - 1000).toISOString();
    store.create({ prompt: "do the thing", runAt: past });
    const due = store.claimDue(new Date());
    expect(due).toHaveLength(1);

    const tools = new ToolRegistry();
    for (const t of makeScheduleTools(store)) tools.register(t);
    const injected: string[] = [];
    const model: ModelAdapter = {
      async complete() {
        return {
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
        };
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
      enableSchedule: true,
    });
    agent.scheduleStore!.create({
      prompt: "wake up",
      runAt: new Date(Date.now() - 500).toISOString(),
    });
    const orig = agent.inject.bind(agent);
    agent.inject = async (content) => {
      injected.push(typeof content === "string" ? content : "blocks");
      return orig(content);
    };
    expect(agent.tickSchedules()).toBe(1);
    expect(injected[0]).toMatch(/wake up/);
  });
});

describe("goals + present", () => {
  it("creates and updates goals", async () => {
    const store = createGoalStore();
    const tools = makeGoalTools(store);
    const create = tools[0]!;
    const update = tools[2]!;
    const ctx = makeCtx();
    const created = JSON.parse(
      String((await create.execute({ title: "Ship gaps" }, ctx)).content),
    ) as { goal: { id: string } };
    const updated = JSON.parse(
      String(
        (
          await update.execute(
            { id: created.goal.id, status: "completed" },
            ctx,
          )
        ).content,
      ),
    ) as { goal: { status: string } };
    expect(updated.goal.status).toBe("completed");
  });

  it("present records deliverables on session metadata", async () => {
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    const tool = makePresentTool({ getSession: () => session });
    await tool.execute(
      { path: "out.md", note: "final" },
      {
        cwd: "/tmp",
        session,
        abortSignal: new AbortController().signal,
      },
    );
    const meta = session.metadata as {
      deliverables?: Array<{ path: string }>;
    };
    expect(meta.deliverables?.[0]?.path).toBe("out.md");
  });
});

describe("workflow work_budget", () => {
  it("admits only workBudget children in parallel", async () => {
    let submits = 0;
    const submitter = {
      async submit(): Promise<SubagentResult> {
        submits += 1;
        return {
          status: "completed",
          content: [{ type: "text", text: "ok" }],
          costUsd: 0,
          durationMs: 1,
          workerPeerId: "local",
          workerRuntime: "envoy-harness",
          verdict: { kind: "pass", score: 1, confidence: "high" },
          signature: "",
        };
      },
    };
    const out = await parallel(
      submitter,
      [
        {
          objective: "a",
          capabilityTag: "t",
          costCeilingUsd: 1,
          deadlineMs: 1000,
        },
        {
          objective: "b",
          capabilityTag: "t",
          costCeilingUsd: 1,
          deadlineMs: 1000,
        },
        {
          objective: "c",
          capabilityTag: "t",
          costCeilingUsd: 1,
          deadlineMs: 1000,
        },
      ],
      { workBudget: 2 },
    );
    expect(submits).toBe(2);
    expect(out.results).toHaveLength(2);
    expect(out.budgetExhausted).toBe(true);
  });
});

describe("loopback remote jobs", () => {
  it("fetches via peer://self/jobs/…", async () => {
    const registry = createLocalJobRegistry({ maxConcurrentJobsPerOwner: 4 });
    const transport = createLoopbackRemoteJobTransport({
      registry,
      viewer: "s1",
    });
    const id = registry.start({
      owner: "s1",
      kind: "bash",
      label: "echo",
      run: () => ({
        done: Promise.resolve({
          status: "completed" as const,
          detail: "ok",
        }),
        cancel: () => undefined,
        readOutput: () => "",
      }),
    });
    const ref = formatRemoteJobRef("self", id);
    const snap = await transport.fetchJob(ref, new AbortController().signal);
    expect(snap.id).toBe(id);
  });
});

describe("handshake backoff", () => {
  it("retries then succeeds", async () => {
    let n = 0;
    const v = await withHandshakeBackoff(
      async () => {
        n += 1;
        if (n < 3) throw new Error("fail");
        return "ok";
      },
      {
        maxRetries: 5,
        initialDelayMs: 1,
        maxDelayMs: 5,
        sleep: async () => undefined,
      },
    );
    expect(v).toBe("ok");
    expect(n).toBe(3);
  });
});

describe("generation fencing", () => {
  it("assigns generation on continuable spawn", async () => {
    const model: ModelAdapter = {
      async complete() {
        return {
          content: [{ type: "text", text: "child done" }],
          stopReason: "end_turn",
        };
      },
    };
    const submitter = new LocalMeshSubmitter({
      buildSubagent: defaultBuildSubagentFactory({ model }),
      workerPeerId: "local",
    });
    const handle = submitter.submitContinuable({
      objective: "x",
      capabilityTag: "t",
      costCeilingUsd: 1,
      deadlineMs: 5000,
    });
    expect(handle.status().generation).toBeTypeOf("number");
    handle.close();
    await handle.waitSettle({ timeoutMs: 5000 });
  });
});
