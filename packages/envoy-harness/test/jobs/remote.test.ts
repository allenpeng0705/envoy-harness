/**
 * R4.12 — mesh-remote JobTransport (hermetic fake).
 */

import { describe, expect, it } from "vitest";

import {
  createLocalJobRegistry,
  FakeRemoteJobTransport,
  formatRemoteJobRef,
  isRemoteJobRef,
  NOOP_REMOTE_JOB_TRANSPORT,
  parseRemoteJobRef,
  RemoteJobError,
  type JobHooks,
  type JobOutcome,
} from "../../src/jobs/index.js";

function controllableJob(output = "hello"): {
  hooks: JobHooks;
  settle: (outcome: JobOutcome) => void;
} {
  let resolveDone!: (o: JobOutcome) => void;
  const done = new Promise<JobOutcome>((resolve) => {
    resolveDone = resolve;
  });
  let buf = output;
  return {
    settle: (o) => resolveDone(o),
    hooks: {
      cancel() {
        /* noop */
      },
      done,
      readOutput() {
        const t = buf;
        buf = "";
        return t;
      },
    },
  };
}

describe("R4.12 remote job refs", () => {
  it("formats and parses peer:// refs", () => {
    const ref = formatRemoteJobRef("alice", "bash-1");
    expect(ref).toBe("peer://alice/jobs/bash-1");
    expect(isRemoteJobRef(ref)).toBe(true);
    expect(parseRemoteJobRef(ref)).toEqual({
      peerId: "alice",
      jobId: "bash-1",
    });
    expect(() => parseRemoteJobRef("bash-1")).toThrow(RemoteJobError);
  });
});

describe("FakeRemoteJobTransport", () => {
  it("fetches, reads, lists, and kills across attached peers", async () => {
    const local = createLocalJobRegistry();
    const c = controllableJob("out");
    const jobId = local.start({
      kind: "bash",
      label: "echo",
      owner: "s1",
      run: () => c.hooks,
    });

    const transport = new FakeRemoteJobTransport();
    transport.attachPeer("worker-a", local, { viewer: "s1" });
    const ref = formatRemoteJobRef("worker-a", jobId);
    const signal = new AbortController().signal;

    const snap = await transport.fetchJob(ref, signal);
    expect(snap.id).toBe(jobId);
    expect(snap.status).toBe("running");

    const read = await transport.readOutput(ref, signal);
    expect(read.text).toBe("out");

    const listed = await transport.listJobs("peer://worker-a", signal);
    expect(listed.map((j) => j.id)).toContain(jobId);

    const killResult = await transport.kill(ref, signal, "test");
    expect(killResult).toBe("requested");
    c.settle({ status: "killed", detail: "test" });
    await local.wait(jobId, 1_000, "s1");
    expect((await transport.fetchJob(ref, signal)).status).toBe("killed");
  });

  it("throws NOT_FOUND for unknown peer or job", async () => {
    const transport = new FakeRemoteJobTransport();
    const signal = new AbortController().signal;
    await expect(
      transport.fetchJob(formatRemoteJobRef("missing", "x"), signal),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("respects abort", async () => {
    const transport = new FakeRemoteJobTransport();
    transport.attachPeer("p", createLocalJobRegistry());
    const ac = new AbortController();
    ac.abort();
    await expect(
      transport.listJobs("p", ac.signal),
    ).rejects.toMatchObject({ code: "TRANSPORT" });
  });
});

describe("NOOP_REMOTE_JOB_TRANSPORT", () => {
  it("stays NOT_CONFIGURED", async () => {
    await expect(
      NOOP_REMOTE_JOB_TRANSPORT.fetchJob(
        formatRemoteJobRef("p", "j"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});
