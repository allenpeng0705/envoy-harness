/**
 * job_output wait: true — DeepSeek-aligned join on read.
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  newSessionId,
  ToolRegistry,
  type ModelAdapter,
} from "../../src/index.js";
import { createLocalJobRegistry } from "../../src/jobs/index.js";
import { makeJobTools } from "../../src/jobs/tools.js";
import type { JobHooks, JobOutcome } from "../../src/jobs/types.js";
import { JOB_SETTLEMENT_NOTICE_PREFIX } from "../../src/subagent/settlement-notice.js";

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
      readOutput: () => "partial-out",
    },
  };
}

describe("job_output wait", () => {
  it("blocks until settle when wait: true", async () => {
    const reg = createLocalJobRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const c = controllableJob();
    const id = reg.start({
      kind: "bash",
      label: "x",
      owner: session.id,
      run: () => c.hooks,
    });
    const tools = makeJobTools(reg);
    const jobOutput = tools.find((t) => t.name === "job_output")!;
    const pending = jobOutput.execute(
      { id, wait: true, timeout_ms: 5_000 },
      {
        cwd: "/tmp",
        session,
        abortSignal: new AbortController().signal,
      },
    );
    c.settle({ status: "completed", output: "done" });
    const out = await pending;
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(String(out.content)) as {
      snapshot: { status: string };
      text: string;
    };
    expect(parsed.snapshot.status).toBe("completed");
    await reg.dispose();
  });

  it("returns timed_out wait marker without failing the tool", async () => {
    const reg = createLocalJobRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const c = controllableJob();
    const id = reg.start({
      kind: "bash",
      label: "x",
      owner: session.id,
      run: () => c.hooks,
    });
    const tools = makeJobTools(reg);
    const jobOutput = tools.find((t) => t.name === "job_output")!;
    const out = await jobOutput.execute(
      { id, wait: true, timeout_ms: 30 },
      {
        cwd: "/tmp",
        session,
        abortSignal: new AbortController().signal,
      },
    );
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(String(out.content)) as {
      wait?: string;
      snapshot: { status: string };
    };
    expect(parsed.wait).toBe("timed_out");
    expect(parsed.snapshot.status).toBe("running");
    c.settle({ status: "completed" });
    await reg.dispose();
  });

  it("returns wait: interrupted when abortSignal fires during wait", async () => {
    const reg = createLocalJobRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model: {
        async complete() {
          return {
            content: [{ type: "text", text: "ok" }],
            stopReason: "end_turn",
          };
        },
      } satisfies ModelAdapter,
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      systemPrompt: "test",
      jobRegistry: reg,
    });
    const c = controllableJob();
    const id = reg.start({
      kind: "bash",
      label: "abort-wait",
      owner: session.id,
      run: () => c.hooks,
    });
    const tools = makeJobTools(reg);
    const jobOutput = tools.find((t) => t.name === "job_output")!;
    const ac = new AbortController();
    const pending = jobOutput.execute(
      { id, wait: true, timeout_ms: 30_000 },
      {
        cwd: "/tmp",
        session,
        abortSignal: ac.signal,
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const out = await pending;
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(String(out.content)) as {
      wait?: string;
      snapshot: { status: string };
    };
    expect(parsed.wait).toBe("interrupted");
    expect(parsed.snapshot.status).toBe("running");

    // Suppress released in finally — later settle still notifies.
    c.settle({ status: "completed", output: "done" });
    await Promise.resolve();
    await Promise.resolve();
    expect(
      agent.pendingSettlementNotices.some((n) =>
        n.includes(JOB_SETTLEMENT_NOTICE_PREFIX),
      ),
    ).toBe(true);
    await reg.dispose();
  });

  it("after wait timeout, a later settle still enqueues a notice", async () => {
    const reg = createLocalJobRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model: {
        async complete() {
          return {
            content: [{ type: "text", text: "ok" }],
            stopReason: "end_turn",
          };
        },
      } satisfies ModelAdapter,
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      systemPrompt: "test",
      jobRegistry: reg,
    });
    const c = controllableJob();
    const id = reg.start({
      kind: "bash",
      label: "late-notice",
      owner: session.id,
      run: () => c.hooks,
    });
    const tools = makeJobTools(reg);
    const jobOutput = tools.find((t) => t.name === "job_output")!;
    await jobOutput.execute(
      { id, wait: true, timeout_ms: 30 },
      {
        cwd: "/tmp",
        session,
        abortSignal: new AbortController().signal,
      },
    );
    // Suppress released in finally — settle after timeout should notify.
    c.settle({ status: "completed", output: "done" });
    await Promise.resolve();
    await Promise.resolve();
    expect(
      agent.pendingSettlementNotices.some((n) =>
        n.includes(JOB_SETTLEMENT_NOTICE_PREFIX),
      ),
    ).toBe(true);
    await reg.dispose();
  });

  it("suppresses settlement notice while job_output wait is active", async () => {
    const reg = createLocalJobRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model: {
        async complete() {
          return {
            content: [{ type: "text", text: "ok" }],
            stopReason: "end_turn",
          };
        },
      } satisfies ModelAdapter,
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      systemPrompt: "test",
      jobRegistry: reg,
    });

    const c = controllableJob();
    const id = reg.start({
      kind: "bash",
      label: "waited",
      owner: session.id,
      run: () => c.hooks,
    });
    const tools = makeJobTools(reg);
    const jobOutput = tools.find((t) => t.name === "job_output")!;
    const pending = jobOutput.execute(
      { id, wait: true, timeout_ms: 5_000 },
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
    ).toBe(false);
    await reg.dispose();
  });

  it("suppresses happy-path notice when job_kill marks the settle", async () => {
    const reg = createLocalJobRegistry();
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    });
    const agent = new Agent({
      model: {
        async complete() {
          return {
            content: [{ type: "text", text: "ok" }],
            stopReason: "end_turn",
          };
        },
      } satisfies ModelAdapter,
      tools: new ToolRegistry(),
      session,
      hooks: new HookRegistry(),
      systemPrompt: "test",
      jobRegistry: reg,
    });

    const c = controllableJob();
    const id = reg.start({
      kind: "bash",
      label: "kill-me",
      owner: session.id,
      run: () => c.hooks,
    });
    const tools = makeJobTools(reg);
    const jobKill = tools.find((t) => t.name === "job_kill")!;
    await jobKill.execute(
      { id, reason: "no longer needed" },
      {
        cwd: "/tmp",
        session,
        abortSignal: new AbortController().signal,
      },
    );
    // kill marks suppress; producer may still settle as killed/completed
    c.settle({ status: "killed", detail: "cancelled" });
    await Promise.resolve();
    await Promise.resolve();

    expect(
      agent.pendingSettlementNotices.some((n) =>
        n.includes(JOB_SETTLEMENT_NOTICE_PREFIX),
      ),
    ).toBe(false);
    await reg.dispose();
  });
});
