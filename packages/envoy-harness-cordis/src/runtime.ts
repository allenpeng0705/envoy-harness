/**
 * C0 spike — host `dsh-jobs-local` on a real Cordis root context.
 *
 * **C1 refactor:** the jobs host is now a thin specialization of the
 * general `createCordisContainer` (whitelist-driven, dependency
 * order, error isolation, ordered dispose). C0's direct boot is
 * folded into the container; the host just attaches a controller
 * and exposes `ctx.jobs`.
 *
 * **Usage (spike scope):** unowned jobs only (`JobStart.owner`
 * omitted) — the dsh owner type is a live `Agent` instance; wiring
 * envoy sessions as owners is a C2/C3 adapter task.
 */

import type { JobRegistry } from "@deepseek-ai/dsh-jobs";

import { createCordisContainer } from "./container.js";

export interface CordisJobsHostOptions {
  /** Default 10 (the dsh registry's own default). */
  maxConcurrentJobsPerOwner?: number;
  /** Controller name for `attachController` (default `"envoy-harness-host"`). */
  controllerName?: string;
}

export interface CordisJobsHost {
  /** The hosted `ctx.jobs` registry (dsh contract). */
  readonly jobs: JobRegistry;
  /** Resolved once the container is booted (kept for API stability). */
  ready(): Promise<void>;
  /** Detach the controller + dispose the Cordis fibers (idempotent). */
  dispose(): Promise<void>;
}

/** Boot a Cordis container hosting the deepseek process-local jobs plugin. */
export async function createCordisJobsHost(
  options: CordisJobsHostOptions = {},
): Promise<CordisJobsHost> {
  const container = await createCordisContainer({
    hostControllerName: options.controllerName ?? "envoy-harness-host",
    plugins: [
      {
        name: "jobs-local",
        config: {
          maxConcurrentJobsPerOwner: options.maxConcurrentJobsPerOwner ?? 10,
        },
      },
    ],
  });
  let disposed = false;

  return {
    jobs: container.ctx.jobs,
    async ready() {},
    async dispose() {
      if (disposed) return;
      disposed = true;
      await container.dispose();
    },
  };
}
