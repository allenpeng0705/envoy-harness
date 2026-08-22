/**
 * C0 spike parity test — the hosted deepseek `dsh-jobs-local` and
 * envoy-harness's native `src/jobs` port produce the same lifecycle
 * outcomes for the same producer contract.
 *
 * This is the gate from `docs/cordis-compat-plan.md` C0: if parity
 * holds, hosting the deepseek ecosystem is viable; if it diverges,
 * the spike reports the divergence before the container is built.
 */

import { describe, expect, it } from "vitest";

import type { JobHooks, JobId, JobOutcome } from "@deepseek-ai/dsh-jobs";
import {
  createLocalJobRegistry,
} from "@envoymesh/envoy-harness";
import { createCordisJobsHost } from "../src/index.js";

/** One producer contract, run through both registries. */
function fakeProducer(delayMs = 3): JobHooks {
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

async function runLifecycle(
  start: (label: string) => string,
  get: (id: string) => { status: string },
  wait: (id: string) => Promise<{ status: string }>,
  kill: (id: string) => string,
): Promise<{
  statuses: string[];
  killResult: string;
}> {
  const id = start("parity job");
  const running = get(id);
  const settled = await wait(id);
  const killResult = kill(id); // killing a settled job is a no-op path
  return {
    statuses: [running.status, settled.status, get(id).status],
    killResult,
  };
}

describe("dsh-jobs-local parity vs envoy src/jobs", () => {
  it("produces the same lifecycle outcomes for the same producer", async () => {
    // Hosted (deepseek Cordis plugin).
    const host = await createCordisJobsHost();
    const hosted = await runLifecycle(
      (label) =>
        host.jobs.start({
          kind: "bash",
          label,
          run: () => fakeProducer(),
        }) as string,
      (id) => host.jobs.get(id as JobId),
      (id) => host.jobs.wait(id as JobId, 2_000),
      (id) => host.jobs.kill(id as JobId),
    );

    // Native (envoy L3 port).
    const env = createLocalJobRegistry();
    const native = await runLifecycle(
      (label) =>
        env.start({
          kind: "bash",
          label,
          run: () => fakeProducer(),
        }),
      (id) => env.get(id, undefined),
      (id) => env.wait(id, 2_000, undefined),
      (id) => env.kill(id, undefined),
    );

    expect(hosted.statuses).toEqual(native.statuses);
    expect(hosted.statuses).toEqual(["running", "completed", "completed"]);

    await host.dispose();
  });
});
