/**
 * R4.7 — bind a {@link TeamJobRegistry} to {@link Team} lifecycle callbacks.
 */

import type { TeamOptions } from "@envoymesh/envoy-harness";

import { TeamJobRegistry, hostLabel } from "./team-jobs.js";

/**
 * Produce `TeamOptions` lifecycle hooks that mirror runs onto a registry.
 */
export function createTeamJobTracker(
  registry: TeamJobRegistry,
): Pick<
  TeamOptions,
  "onTeamStart" | "onAgentStart" | "onAgentFinish" | "onTeamFinish"
> {
  let jobId: string | undefined;
  return {
    onTeamStart({ teamName, agents }) {
      jobId = registry.startTeamJob({
        teamName,
        agents: agents.map((a) => ({
          id: a.id,
          host: hostLabel(a.host),
        })),
      });
    },
    onAgentStart({ spec }) {
      if (jobId === undefined) return;
      registry.setAgentStatus(jobId, spec.id, {
        status: "running",
        startedAt: new Date().toISOString(),
      });
    },
    onAgentFinish({ spec, result }) {
      if (jobId === undefined) return;
      const failed = result.stopReason === "aborted";
      registry.setAgentStatus(jobId, spec.id, {
        status: failed ? "failed" : "completed",
        completedAt: new Date().toISOString(),
      });
    },
    onTeamFinish({ result }) {
      if (jobId === undefined) return;
      registry.finishTeamJob(
        jobId,
        result.status === "completed" ? "completed" : "failed",
      );
      jobId = undefined;
    },
  };
}
