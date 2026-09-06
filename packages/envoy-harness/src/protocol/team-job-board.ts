/**
 * R4.14 — unified ACP `team/jobs` board (Scenario A chain + Scenario B peer).
 *
 * One {@link ProtocolTeamJob} schema; hosts merge chain-worker projections
 * and peer {@link TeamJobRegistry} lists via {@link mergeTeamJobBoards}.
 */

import { randomUUID } from "node:crypto";

import type {
  ProtocolTeamAgentStatus,
  ProtocolTeamJob,
} from "./session-backend.js";

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
 * Minimal chain-subtask view for mapping into {@link ProtocolTeamJob}.
 * EnvoyMesh / Protocol `ChainSubtask` satisfies this structurally.
 */
export interface ChainSubtaskJobView {
  chainId: string;
  subtaskId: string;
  createdAt: string;
  /** Defaults to `"mesh-worker"`. */
  host?: string;
  model?: string;
  status?: ProtocolTeamAgentStatus["status"];
}

/**
 * In-memory board of team runs + peer submits for ACP `team/jobs`.
 * Shared by peer package and mesh hosts (R4.7 + R4.14).
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

  /** Upsert a pre-built job (e.g. chain projection merge). */
  upsert(job: ProtocolTeamJob): void {
    this.jobs.set(job.jobId, job);
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

/**
 * Scenario A — group chain subtasks into one {@link ProtocolTeamJob} per
 * `chainId` (same shape as EnvoyMesh U4 `chainWorkerSubtasksToTeamJobs`).
 */
export function chainSubtasksToTeamJobs(
  subtasks: ReadonlyArray<ChainSubtaskJobView>,
): ProtocolTeamJob[] {
  const byChain = new Map<string, ProtocolTeamJob>();
  for (const s of subtasks) {
    let job = byChain.get(s.chainId);
    if (job === undefined) {
      job = {
        jobId: s.chainId,
        status: "running",
        createdAt: s.createdAt,
        agents: [],
      };
      byChain.set(s.chainId, job);
    }
    const agent: ProtocolTeamAgentStatus = {
      id: s.subtaskId,
      host: s.host ?? "mesh-worker",
      status: s.status ?? "running",
    };
    if (s.model !== undefined) agent.model = s.model;
    job.agents.push(agent);
  }
  return [...byChain.values()];
}

/**
 * Merge multiple ACP boards. Later sources win on duplicate `jobId`.
 * Sorted newest `createdAt` first (same as {@link TeamJobRegistry.list}).
 */
export function mergeTeamJobBoards(
  boards: ReadonlyArray<ReadonlyArray<ProtocolTeamJob>>,
): ProtocolTeamJob[] {
  const byId = new Map<string, ProtocolTeamJob>();
  for (const board of boards) {
    for (const job of board) {
      byId.set(job.jobId, job);
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
}
