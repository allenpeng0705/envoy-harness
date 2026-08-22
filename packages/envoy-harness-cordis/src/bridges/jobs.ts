/**
 * C4 — bridge hosted dsh jobs into envoy-harness's native `JobRegistry`
 * contract, so envoy's own model-facing job tools can drive jobs hosted
 * by deepseek plugins (e.g. `jobs-local`).
 *
 * Owners: the dsh contract fences owned jobs by a live Agent, which the
 * bridge does not model — jobs are started unowned (open to any caller),
 * matching the envoy contract's optional string owner. The bridge tracks
 * envoy owners for `disposeOwner` and kills their jobs on demand.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { JobId, JobStart as DshJobStart } from "@deepseek-ai/dsh-jobs";
import type {
  JobDoneListener,
  JobHooks as EnvoyJobHooks,
  JobRead,
  JobRegistry as EnvoyJobRegistry,
  JobSnapshot,
  JobStart as EnvoyJobStart,
} from "@envoymesh/envoy-harness";

export function createHostedJobsRegistry(ctx: Context): EnvoyJobRegistry {
  const owned = new Map<string, Array<{ id: string; hooks: EnvoyJobHooks }>>();

  return {
    start(spec: EnvoyJobStart): string {
      // Capture the producer's hooks so `disposeOwner` can await
      // settlement (the envoy JobRegistry contract). dsh invokes
      // `run()` synchronously during `start`.
      let hooks: EnvoyJobHooks | undefined;
      const dshSpec: DshJobStart = {
        kind: spec.kind as DshJobStart["kind"],
        label: spec.label,
        ...(spec.outputLimitBytes !== undefined
          ? { outputLimitBytes: spec.outputLimitBytes }
          : {}),
        run: (() => {
          const produced = spec.run();
          hooks = produced as EnvoyJobHooks;
          return produced as unknown as DshJobStart["run"];
        }) as unknown as DshJobStart["run"],
      };
      const id = ctx.jobs.start(dshSpec) as unknown as string;
      if (spec.owner !== undefined) {
        const list = owned.get(spec.owner) ?? [];
        list.push({ id, hooks: hooks ?? { cancel: () => {}, done: Promise.resolve({ status: "killed" }) } });
        owned.set(spec.owner, list);
      }
      return id;
    },
    list(caller?: string): JobSnapshot[] {
      return ctx.jobs.list(caller as never) as unknown as JobSnapshot[];
    },
    get(id: string, caller?: string): JobSnapshot {
      return ctx.jobs.get(id as JobId, caller as never) as unknown as JobSnapshot;
    },
    read(id: string, caller?: string): JobRead {
      return ctx.jobs.read(id as JobId, caller as never) as unknown as JobRead;
    },
    kill(
      id: string,
      caller?: string,
      reason?: string,
    ): "requested" | "already-finished" {
      return ctx.jobs.kill(
        id as JobId,
        caller as never,
        reason,
      ) as "requested" | "already-finished";
    },
    wait(
      id: string,
      timeoutMs: number,
      caller?: string,
      signal?: AbortSignal,
    ): Promise<JobSnapshot> {
      return ctx.jobs.wait(
        id as JobId,
        timeoutMs,
        caller as never,
        signal,
      ) as Promise<JobSnapshot>;
    },
    onJobDone(listener: JobDoneListener): () => void {
      return ctx.jobs.onJobDone(listener as never);
    },
    async disposeOwner(owner: string): Promise<void> {
      const jobs = owned.get(owner) ?? [];
      for (const job of jobs) {
        ctx.jobs.kill(job.id as JobId, undefined);
      }
      // Await settlement so the caller knows the owner's work is done
      // (envoy's contract). A rejecting `done` must not block teardown.
      await Promise.all(
        jobs.map((job) => job.hooks.done.catch(() => undefined)),
      );
      owned.delete(owner);
    },
    async dispose(): Promise<void> {
      // The container owns Cordis teardown; this bridge has no lifecycle
      // of its own. Left as a no-op so it satisfies the envoy contract.
    },
  };
}
