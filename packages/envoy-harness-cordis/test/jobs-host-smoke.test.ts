/**
 * C0 spike smoke test — the deepseek Cordis stack boots and the hosted
 * jobs registry drives a full job lifecycle.
 */

import { describe, expect, it } from "vitest";

import type { JobHooks, JobOutcome } from "@deepseek-ai/dsh-jobs";
import { createCordisJobsHost } from "../src/index.js";

/** A fake producer: completes after a tick unless cancelled. */
function fakeProducer(delayMs = 5): JobHooks {
  let resolveDone: (o: JobOutcome) => void = () => {};
  const done = new Promise<JobOutcome>((r) => {
    resolveDone = r;
  });
  const timer = setTimeout(
    () => resolveDone({ status: "completed", detail: "fake" }),
    delayMs,
  );
  return {
    cancel(reason?: string) {
      clearTimeout(timer);
      resolveDone({
        status: "killed",
        ...(reason !== undefined ? { detail: reason } : {}),
      });
    },
    done,
  };
}

describe("createCordisJobsHost (deepseek dsh-jobs-local on real Cordis)", () => {
  it("boots and registers ctx.jobs as the dsh JobRegistry", async () => {
    const host = await createCordisJobsHost();
    expect(host.jobs).toBeDefined();
    expect(typeof host.jobs.start).toBe("function");
    expect(typeof host.jobs.get).toBe("function");
    await host.dispose();
  });

  it("drives a full job lifecycle (running → completed) with snapshots", async () => {
    const host = await createCordisJobsHost();

    const id = host.jobs.start({
      kind: "bash",
      label: "ls -la",
      run: () => fakeProducer(5),
    });
    expect(id).toMatch(/^bash-\d+$/);

    const running = host.jobs.get(id);
    expect(running.status).toBe("running");
    expect(running.kind).toBe("bash");
    expect(running.label).toBe("ls -la");
    expect(running.startedAt).toBeGreaterThan(0);

    const settled = await host.jobs.wait(id, 2_000);
    expect(settled.status).toBe("completed");
    expect(host.jobs.get(id).status).toBe("completed");

    await host.dispose();
  });

  it("kills a running job and settles it as killed", async () => {
    const host = await createCordisJobsHost();

    let resolveDone: (o: JobOutcome) => void = () => {};
    const done = new Promise<JobOutcome>((r) => {
      resolveDone = r;
    });
    const id = host.jobs.start({
      kind: "bash",
      label: "sleep 999",
      run: () => ({
        cancel(reason?: string) {
          resolveDone({
            status: "killed",
            ...(reason !== undefined ? { detail: reason } : {}),
          });
        },
        done,
      }),
    });
    const result = host.jobs.kill(id);
    expect(result).toBe("requested");
    const settled = await host.jobs.wait(id, 2_000);
    expect(settled.status).toBe("killed");

    await host.dispose();
  });
});
