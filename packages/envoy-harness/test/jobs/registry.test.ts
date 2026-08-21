/**
 * Phase C / Item 7 — local job registry tests (hermetic).
 */

import { describe, expect, it } from "vitest";

import {
  createLocalJobRegistry,
  JobError,
  type JobHooks,
  type JobOutcome,
} from "../../src/jobs/index.js";

function controllableJob(): {
  hooks: JobHooks;
  settle: (outcome: JobOutcome) => void;
  cancels: string[];
} {
  const cancels: string[] = [];
  let resolveDone!: (o: JobOutcome) => void;
  const done = new Promise<JobOutcome>((resolve) => {
    resolveDone = resolve;
  });
  let output = "";
  return {
    cancels,
    settle: (o) => resolveDone(o),
    hooks: {
      cancel(reason) {
        cancels.push(reason ?? "");
      },
      done,
      readOutput() {
        const t = output;
        output = "";
        return t;
      },
    },
  };
}

describe("createLocalJobRegistry", () => {
  it("starts, settles, and snapshots", async () => {
    const reg = createLocalJobRegistry();
    const c = controllableJob();
    const id = reg.start({
      kind: "bash",
      label: "echo hi",
      owner: "s1",
      run: () => c.hooks,
    });
    expect(id).toBe("bash-1");
    expect(reg.get(id, "s1").status).toBe("running");
    c.settle({ status: "completed", detail: "exit 0" });
    const snap = await reg.wait(id, 1000, "s1");
    expect(snap.status).toBe("completed");
    await reg.dispose();
  });

  it("fences foreign owners", () => {
    const reg = createLocalJobRegistry();
    const c = controllableJob();
    const id = reg.start({
      kind: "bash",
      label: "x",
      owner: "alice",
      run: () => c.hooks,
    });
    expect(() => reg.get(id, "bob")).toThrow(JobError);
    expect(() => reg.kill(id, "bob")).toThrow(JobError);
    expect(reg.list("bob")).toEqual([]);
    expect(reg.list("alice")).toHaveLength(1);
  });

  it("allows unowned jobs for any caller", () => {
    const reg = createLocalJobRegistry();
    const c = controllableJob();
    const id = reg.start({
      kind: "bash",
      label: "open",
      run: () => c.hooks,
    });
    expect(reg.get(id).status).toBe("running");
    expect(reg.get(id, "anyone").id).toBe(id);
  });

  it("enforces per-owner concurrency limit", () => {
    const reg = createLocalJobRegistry({ maxConcurrentJobsPerOwner: 1 });
    const a = controllableJob();
    const b = controllableJob();
    reg.start({ kind: "bash", label: "a", owner: "s", run: () => a.hooks });
    expect(() =>
      reg.start({ kind: "bash", label: "b", owner: "s", run: () => b.hooks }),
    ).toThrow(/limit/);
  });

  it("kill requests cancel and marks stopping", async () => {
    const reg = createLocalJobRegistry();
    const c = controllableJob();
    const id = reg.start({
      kind: "bash",
      label: "long",
      owner: "s1",
      run: () => c.hooks,
    });
    expect(reg.kill(id, "s1", "user")).toBe("requested");
    expect(c.cancels).toEqual(["user"]);
    expect(reg.get(id, "s1").status).toBe("stopping");
    c.settle({ status: "killed", detail: "user" });
    const snap = await reg.wait(id, 1000, "s1");
    expect(snap.status).toBe("killed");
    await reg.dispose();
  });

  it("wait times out", async () => {
    const reg = createLocalJobRegistry();
    const c = controllableJob();
    const id = reg.start({
      kind: "bash",
      label: "slow",
      owner: "s1",
      run: () => c.hooks,
    });
    await expect(reg.wait(id, 20, "s1")).rejects.toMatchObject({
      code: "WAIT_TIMEOUT",
    });
    c.settle({ status: "completed" });
    await reg.dispose();
  });

  it("onJobDone fires once on settle", async () => {
    const reg = createLocalJobRegistry();
    const c = controllableJob();
    const seen: string[] = [];
    reg.onJobDone((s) => seen.push(s.id));
    const id = reg.start({
      kind: "bash",
      label: "x",
      owner: "s1",
      run: () => c.hooks,
    });
    c.settle({ status: "completed" });
    await reg.wait(id, 1000, "s1");
    expect(seen).toEqual([id]);
    await reg.dispose();
  });
});
