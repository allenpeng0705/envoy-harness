/**
 * job_output wait: true — DeepSeek-aligned join on read.
 */

import { describe, expect, it } from "vitest";

import { InMemorySession, newSessionId } from "../../src/index.js";
import { createLocalJobRegistry } from "../../src/jobs/index.js";
import { makeJobTools } from "../../src/jobs/tools.js";
import type { JobHooks, JobOutcome } from "../../src/jobs/types.js";

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
});
