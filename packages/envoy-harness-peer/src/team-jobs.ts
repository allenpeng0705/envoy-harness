/**
 * R4.7 — live `team/jobs` registry for the standalone peer path.
 *
 * Same {@link ProtocolTeamJob} shape as mesh U4 so TUI `/team` works
 * without EnvoyMesh.
 */

import { randomUUID } from "node:crypto";

import type {
  ProtocolTeamAgentStatus,
  ProtocolTeamJob,
} from "@envoymesh/envoy-harness";

export interface StartTeamJobInput {
  teamName: string;
  agents: ReadonlyArray<{
    id: string;
    host: string;
    model?: string;
  }>;
}

export interface StartPeerSubmitJobInput {
  objective: string;
  capabilityTag: string;
  peerId: string;
  model?: string;
}

/**
 * In-memory board of team runs + peer submits for ACP `team/jobs`.
 */
export class TeamJobRegistry {
  private readonly jobs = new Map<string, ProtocolTeamJob>();

  startTeamJob(input: StartTeamJobInput): string {
    const jobId = `team-${input.teamName}-${randomUUID().slice(0, 8)}`;
    const job: ProtocolTeamJob = {
      jobId,
      status: "running",
      createdAt: new Date().toISOString(),
      agents: input.agents.map((a) => {
        const row: ProtocolTeamAgentStatus = {
          id: a.id,
          host: a.host,
          status: "pending",
        };
        if (a.model !== undefined) row.model = a.model;
        return row;
      }),
    };
    this.jobs.set(jobId, job);
    return jobId;
  }

  setAgentStatus(
    jobId: string,
    agentId: string,
    patch: Partial<ProtocolTeamAgentStatus>,
  ): void {
    const job = this.jobs.get(jobId);
    if (job === undefined) return;
    const agents = job.agents.map((a) => {
      if (a.id !== agentId) return a;
      return { ...a, ...patch };
    });
    this.jobs.set(jobId, { ...job, agents });
  }

  finishTeamJob(
    jobId: string,
    status: "completed" | "failed",
    costUsd?: number,
  ): void {
    const job = this.jobs.get(jobId);
    if (job === undefined) return;
    this.jobs.set(jobId, {
      ...job,
      status,
      ...(costUsd !== undefined ? { costUsd } : {}),
      agents: job.agents.map((a) =>
        a.status === "pending" || a.status === "running"
          ? {
              ...a,
              status: status === "completed" ? "completed" : "failed",
              completedAt: a.completedAt ?? new Date().toISOString(),
            }
          : a,
      ),
    });
  }

  startPeerSubmitJob(input: StartPeerSubmitJobInput): string {
    const jobId = `peer-submit-${randomUUID().slice(0, 8)}`;
    const agent: ProtocolTeamAgentStatus = {
      id: input.capabilityTag || "submit",
      host: `peer://${input.peerId}`,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    if (input.model !== undefined) agent.model = input.model;
    const job: ProtocolTeamJob = {
      jobId,
      status: "running",
      createdAt: new Date().toISOString(),
      agents: [agent],
    };
    this.jobs.set(jobId, job);
    return jobId;
  }

  finishPeerSubmitJob(
    jobId: string,
    status: "completed" | "failed",
    costUsd?: number,
  ): void {
    const job = this.jobs.get(jobId);
    if (job === undefined) return;
    const completedAt = new Date().toISOString();
    this.jobs.set(jobId, {
      ...job,
      status,
      ...(costUsd !== undefined ? { costUsd } : {}),
      agents: job.agents.map((a) => ({
        ...a,
        status,
        completedAt,
        ...(costUsd !== undefined ? { costUsd } : {}),
      })),
    });
  }

  list(): ReadonlyArray<ProtocolTeamJob> {
    return [...this.jobs.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
  }
}

/** Map `AgentSpec.host` to ProtocolTeamAgentStatus.host. */
export function hostLabel(host: string | undefined): string {
  if (host === undefined || host === "local") return "local";
  return host;
}
