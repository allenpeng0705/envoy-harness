/**
 * Background (asynchronous) sub-agents.
 *
 * Before this, `task` always awaited the child, so the continuable
 * runtime and the job registry both existed but no model could reach
 * them. These tests pin the bridge: a background child returns a job id
 * immediately, the existing `job_*` surface observes and cancels it, and
 * a `continuable` child can be steered and interrupted.
 *
 * **Hermetic:** a scripted model adapter, no network, no real provider.
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  createLocalJobRegistry,
  defaultBuildSubagentFactory,
  FanOutRegistry,
  HookRegistry,
  InMemorySession,
  LocalMeshSubmitter,
  makeSubagentControlTools,
  makeTaskTool,
  newSessionId,
  spawnBackgroundSubagent,
  ToolRegistry,
  type MeshSubmitter,
  type ModelAdapter,
  type ModelResponse,
  type SubagentResult,
  type Tool,
  type ToolContext,
} from "../src/index.js";

function scriptedModel(
  responses: ReadonlyArray<{ content: ModelResponse["content"] }>,
): ModelAdapter {
  let i = 0;
  return {
    async complete() {
      const r = responses[i++];
      if (!r) throw new Error(`scriptedModel exhausted (call #${i})`);
      return { content: r.content, stopReason: "end_turn" };
    },
  };
}

function text(t: string): ModelResponse["content"][number] {
  return { type: "text", text: t };
}

function makeCtx(): ToolContext {
  return {
    cwd: "/tmp",
    session: new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    }),
    abortSignal: new AbortController().signal,
  };
}

function localSubmitter(
  responses: ReadonlyArray<{ content: ModelResponse["content"] }>,
): LocalMeshSubmitter {
  return new LocalMeshSubmitter({
    workerPeerId: "local",
    buildSubagent: defaultBuildSubagentFactory({
      model: scriptedModel(responses),
    }),
  });
}

async function until(
  label: string,
  cond: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const BASE_ARGS = {
  objective: "research the thing",
  capability_tag: "test",
  cost_ceiling_usd: 1,
  deadline_ms: 30_000,
} as const;

/** The camelCase `SubagentInput` the submitter (not the tool) speaks. */
const BASE_INPUT = {
  objective: "research the thing",
  capabilityTag: "test",
  costCeilingUsd: 1,
  deadlineMs: 30_000,
} as const;

function toolByName(tools: ReadonlyArray<Tool>, name: string): Tool {
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

describe("task { run_in_background: true }", () => {
  it("returns a job id immediately and the job completes with the child's output", async () => {
    const jobs = createLocalJobRegistry();
    const ctx = makeCtx();
    const submitter = localSubmitter([{ content: [text("background answer")] }]);
    const tool = makeTaskTool({ submitter, jobs });

    const res = await tool.execute(
      { ...BASE_ARGS, run_in_background: true },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(String(res.content)) as {
      job_id: string;
      agent_id: string;
      mode: string;
    };
    expect(parsed.job_id).toBe("subagent-1");
    expect(parsed.mode).toBe("one-shot");
    // The handle id is the child's session id, and it is what the model
    // later passes to list_agents / send_message.
    expect(parsed.agent_id.length).toBeGreaterThan(0);
    expect(submitter.listSubagents()[0]?.sessionId).toBe(parsed.agent_id);

    const snap = await jobs.wait(parsed.job_id, 5_000, ctx.session.id);
    expect(snap.status).toBe("completed");
    expect(jobs.read(parsed.job_id, ctx.session.id).text).toContain(
      "background answer",
    );
    await jobs.dispose();
  });

  it("refuses when the host wired no job registry (never silently blocks)", async () => {
    const submitter = localSubmitter([{ content: [text("nope")] }]);
    const tool = makeTaskTool({ submitter });
    const res = await tool.execute(
      { ...BASE_ARGS, run_in_background: true },
      makeCtx(),
    );
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain("background job registry");
  });

  it("refuses when the submitter cannot run continuable children", async () => {
    const blocking: MeshSubmitter = {
      async submit(): Promise<SubagentResult> {
        throw new Error("unused");
      },
    };
    const jobs = createLocalJobRegistry();
    const tool = makeTaskTool({ submitter: blocking, jobs });
    const res = await tool.execute(
      { ...BASE_ARGS, run_in_background: true },
      makeCtx(),
    );
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain("continuable");
    await jobs.dispose();
  });

  it("refuses to combine background with a fan-out capability tag", async () => {
    const jobs = createLocalJobRegistry();
    const fanOut = new FanOutRegistry();
    fanOut.register({ capabilityTag: "test", count: 3 });
    const submitter = localSubmitter([{ content: [text("x")] }]);
    const tool = makeTaskTool({ submitter, jobs, fanOutRegistry: fanOut });
    const res = await tool.execute(
      { ...BASE_ARGS, run_in_background: true },
      makeCtx(),
    );
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain("fan-out");
    await jobs.dispose();
  });
});

describe("continuable background children", () => {
  it("can be steered with send_message and interrupted", async () => {
    const jobs = createLocalJobRegistry();
    const ctx = makeCtx();
    const submitter = localSubmitter([
      { content: [text("turn one")] },
      { content: [text("turn two")] },
    ]);
    const tool = makeTaskTool({ submitter, jobs });
    const control = makeSubagentControlTools(submitter);

    const res = await tool.execute(
      { ...BASE_ARGS, run_in_background: true, background_mode: "continuable" },
      ctx,
    );
    const parsed = JSON.parse(String(res.content)) as {
      job_id: string;
      agent_id: string;
      mode: string;
    };
    expect(parsed.mode).toBe("continuable");

    // Turn one completes and the child parks, alive, waiting for input.
    await until("turn one", () =>
      jobs.read(parsed.job_id, ctx.session.id).text.includes("turn one"),
    );
    expect(jobs.get(parsed.job_id, ctx.session.id).status).toBe("running");

    const listed = JSON.parse(
      String(
        (await toolByName(control, "list_agents").execute({}, ctx)).content,
      ),
    ) as { agents: Array<{ id: string; status: string }> };
    expect(listed.agents.map((a) => a.id)).toContain(parsed.agent_id);
    expect(listed.agents[0]?.status).toBe("running");

    // Steer it: the follow-up runs as turn two.
    const sent = await toolByName(control, "send_message").execute(
      { agent_id: parsed.agent_id, message: "keep going" },
      ctx,
    );
    expect(sent.isError).toBeUndefined();
    await until("turn two", () =>
      jobs.read(parsed.job_id, ctx.session.id).text.includes("turn two"),
    );

    // interrupt_agent stops the child; the job settles (as failed —
    // interrupting is not the same as killing the job).
    const stopped = await toolByName(control, "interrupt_agent").execute(
      { agent_id: parsed.agent_id, reason: "wrong direction" },
      ctx,
    );
    expect(stopped.isError).toBeUndefined();
    const snap = await jobs.wait(parsed.job_id, 5_000, ctx.session.id);
    expect(snap.status).toBe("failed");
    expect(submitter.listSubagents()[0]?.status).toBe("failed");
    await jobs.dispose();
  });

  it("job_kill cancels the child and settles the job as killed", async () => {
    const jobs = createLocalJobRegistry();
    const ctx = makeCtx();
    const submitter = localSubmitter([{ content: [text("slow")] }]);
    const tool = makeTaskTool({ submitter, jobs });
    const res = await tool.execute(
      { ...BASE_ARGS, run_in_background: true, background_mode: "continuable" },
      ctx,
    );
    const parsed = JSON.parse(String(res.content)) as { job_id: string };

    const killed = jobs.kill(parsed.job_id, ctx.session.id, "user changed mind");
    expect(killed).toBe("requested");
    const snap = await jobs.wait(parsed.job_id, 5_000, ctx.session.id);
    expect(snap.status).toBe("killed");
    await jobs.dispose();
  });

  it("send_message to a settled child reports an error instead of throwing", async () => {
    const jobs = createLocalJobRegistry();
    const ctx = makeCtx();
    const submitter = localSubmitter([{ content: [text("done")] }]);
    const tool = makeTaskTool({ submitter, jobs });
    const control = makeSubagentControlTools(submitter);
    const res = await tool.execute(
      { ...BASE_ARGS, run_in_background: true },
      ctx,
    );
    const parsed = JSON.parse(String(res.content)) as {
      job_id: string;
      agent_id: string;
    };
    await jobs.wait(parsed.job_id, 5_000, ctx.session.id);
    // A one-shot child has already settled: its handle is gone.
    const sent = await toolByName(control, "send_message").execute(
      { agent_id: parsed.agent_id, message: "still there?" },
      ctx,
    );
    // Either the handle is gone (error) or the child refuses — never a throw.
    expect(sent.isError).toBe(true);
    await jobs.dispose();
  });
});

describe("token-level streaming of a running child", () => {
  it("shows the in-flight turn's text through job_output before the turn ends", async () => {
    const jobs = createLocalJobRegistry();
    const ctx = makeCtx();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const streamed: string[] = [];
    const model: ModelAdapter = {
      async complete(params) {
        const first = "partial-one";
        streamed.push(first);
        params.onTextDelta?.(first);
        // Hold the turn open so "mid-turn" is a deterministic observation
        // rather than a race against a fast fake model.
        await gate;
        const second = " and two";
        params.onTextDelta?.(second);
        return {
          content: [{ type: "text", text: first + second }],
          stopReason: "end_turn",
        };
      },
    };
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: defaultBuildSubagentFactory({ model }),
    });
    const tool = makeTaskTool({ submitter, jobs });
    const res = await tool.execute(
      // one-shot: streaming is about seeing a turn *while it runs*, and a
      // one-shot child settles by itself once the turn ends.
      { ...BASE_ARGS, run_in_background: true, background_mode: "one-shot" },
      ctx,
    );
    const parsed = JSON.parse(String(res.content)) as {
      job_id: string;
      agent_id: string;
    };

    // Observe the buffer non-destructively (a consuming read in the
    // predicate would eat the very output it is testing for).
    await until(
      "mid-turn output",
      () => (submitter.getHandle(parsed.agent_id)?.output() ?? "").includes("partial-one"),
    );
    expect(jobs.get(parsed.job_id, ctx.session.id).status).toBe("running");
    // `job_output` is a consuming cursor (as its description promises):
    // the read takes what exists, and the next read has nothing new.
    expect(jobs.read(parsed.job_id, ctx.session.id).text).toBe("partial-one");
    expect(jobs.read(parsed.job_id, ctx.session.id).text).toBe("");

    release();
    const snap = await jobs.wait(parsed.job_id, 5_000, ctx.session.id);
    expect(snap.status).toBe("completed");
    const rest = jobs.read(parsed.job_id, ctx.session.id).text;
    expect(rest).toContain("and two");
    // The streamed copy is replaced by the authoritative turn text rather
    // than doubling it.
    expect(rest).not.toContain("partial-one");
    expect(jobs.read(parsed.job_id, ctx.session.id).text).toBe("");
    await jobs.dispose();
  });

  it("keeps the failure message as output when interrupted before any turn text", async () => {
    const jobs = createLocalJobRegistry();
    const ctx = makeCtx();
    const submitter = localSubmitter([{ content: [text("never reached")] }]);
    const tool = makeTaskTool({ submitter, jobs });
    const res = await tool.execute(
      { ...BASE_ARGS, run_in_background: true, background_mode: "continuable" },
      ctx,
    );
    const parsed = JSON.parse(String(res.content)) as { job_id: string };
    jobs.kill(parsed.job_id, ctx.session.id, "stop");
    await jobs.wait(parsed.job_id, 5_000, ctx.session.id);
    expect(jobs.read(parsed.job_id, ctx.session.id).text).toContain(
      "interrupted",
    );
    await jobs.dispose();
  });
});

describe("Agent registration of the background surface", () => {
  function buildAgentTools(
    submitter: MeshSubmitter,
    jobs: ReturnType<typeof createLocalJobRegistry>,
  ): ToolRegistry {
    const tools = new ToolRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    new Agent({
      model: scriptedModel([{ content: [text("ok")] }]),
      tools,
      session,
      hooks: new HookRegistry(),
      meshSubmitter: submitter,
      jobRegistry: jobs,
    });
    return tools;
  }

  it("registers task + the three control tools for a continuable submitter", async () => {
    const jobs = createLocalJobRegistry();
    const tools = buildAgentTools(
      localSubmitter([{ content: [text("x")] }]),
      jobs,
    );
    const names = new Set(tools.list().map((t) => t.name));
    expect(names.has("task")).toBe(true);
    expect(names.has("list_agents")).toBe(true);
    expect(names.has("send_message")).toBe(true);
    expect(names.has("interrupt_agent")).toBe(true);
    await jobs.dispose();
  });

  it("omits the control tools when the submitter cannot run continuable children", async () => {
    const jobs = createLocalJobRegistry();
    const blocking: MeshSubmitter = {
      async submit(): Promise<SubagentResult> {
        throw new Error("unused");
      },
    };
    const tools = buildAgentTools(blocking, jobs);
    const names = new Set(tools.list().map((t) => t.name));
    expect(names.has("task")).toBe(true);
    // Advertising `send_message` here would promise something that always
    // errors, because the submitter has no handle registry.
    expect(names.has("send_message")).toBe(false);
    await jobs.dispose();
  });
});

describe("spawnBackgroundSubagent", () => {
  it("does not leak a child when the registry rejects the job", async () => {
    const jobs = createLocalJobRegistry({ maxConcurrentJobsPerOwner: 1 });
    const submitter = localSubmitter([
      { content: [text("first")] },
      { content: [text("second")] },
    ]);
    const spawned = spawnBackgroundSubagent({
      submitter,
      jobs,
      mode: "continuable",
      input: { ...BASE_INPUT },
      owner: "owner-1",
    });
    expect(spawned.jobId).toBe("subagent-1");
    expect(submitter.listSubagents()).toHaveLength(1);

    expect(() =>
      spawnBackgroundSubagent({
        submitter,
        jobs,
        mode: "continuable",
        input: { ...BASE_INPUT },
        owner: "owner-1",
      }),
    ).toThrow(/limit/i);
    // The cap was enforced BEFORE a second child was built.
    expect(submitter.listSubagents()).toHaveLength(1);
    await jobs.dispose();
  });
});
