/**
 * R4.14 — unified team/jobs board (chain + peer).
 */

import { describe, expect, it } from "vitest";

import {
  chainSubtasksToTeamJobs,
  mergeTeamJobBoards,
  TeamJobRegistry,
} from "../../src/protocol/team-job-board.js";

describe("chainSubtasksToTeamJobs", () => {
  it("groups subtasks into one job per chainId", () => {
    const jobs = chainSubtasksToTeamJobs([
      {
        chainId: "chain_1",
        subtaskId: "s1",
        createdAt: "2026-09-06T00:00:00.000Z",
      },
      {
        chainId: "chain_1",
        subtaskId: "s2",
        createdAt: "2026-09-06T00:00:01.000Z",
        host: "peer://w1",
        model: "deepseek-chat",
      },
      {
        chainId: "chain_2",
        subtaskId: "s3",
        createdAt: "2026-09-06T00:00:02.000Z",
        status: "completed",
      },
    ]);
    expect(jobs).toHaveLength(2);
    const c1 = jobs.find((j) => j.jobId === "chain_1");
    expect(c1?.agents.map((a) => a.id)).toEqual(["s1", "s2"]);
    expect(c1?.agents[0]).toMatchObject({
      host: "mesh-worker",
      status: "running",
    });
    expect(c1?.agents[1]).toMatchObject({
      host: "peer://w1",
      model: "deepseek-chat",
    });
    expect(jobs.find((j) => j.jobId === "chain_2")?.agents[0]?.status).toBe(
      "completed",
    );
  });
});

describe("mergeTeamJobBoards", () => {
  it("merges chain + peer boards with later win on jobId", () => {
    const peer = new TeamJobRegistry();
    const peerJobId = peer.startPeerSubmitJob({
      objective: "x",
      capabilityTag: "research",
      peerId: "p1",
    });
    const chain = chainSubtasksToTeamJobs([
      {
        chainId: "chain_a",
        subtaskId: "s1",
        createdAt: "2026-09-06T01:00:00.000Z",
      },
    ]);
    const override = [
      {
        jobId: "chain_a",
        status: "failed" as const,
        createdAt: "2026-09-06T01:00:00.000Z",
        agents: [
          {
            id: "s1",
            host: "mesh-worker",
            status: "failed" as const,
          },
        ],
      },
    ];
    const merged = mergeTeamJobBoards([chain, peer.list(), override]);
    expect(merged.map((j) => j.jobId).sort()).toEqual(
      [peerJobId, "chain_a"].sort(),
    );
    expect(merged.find((j) => j.jobId === "chain_a")?.status).toBe("failed");
  });
});
