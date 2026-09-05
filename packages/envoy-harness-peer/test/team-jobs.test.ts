/**
 * R4.7 — TeamJobRegistry + peer UI team/jobs wiring.
 */
import { describe, expect, it } from "vitest";

import { Team, type ModelAdapter, type ModelResponse } from "@envoymesh/envoy-harness";

import { createPeerUiBackend } from "../src/cli/ui.js";
import { PeerRegistry } from "../src/registry.js";
import { createTeamJobTracker } from "../src/team-job-tracker.js";
import { TeamJobRegistry } from "../src/team-jobs.js";

function scriptedModel(
  responses: ReadonlyArray<{ content: ModelResponse["content"] }>,
): ModelAdapter {
  let i = 0;
  return {
    async complete() {
      const r = responses[i++];
      if (!r) throw new Error("script exhausted");
      return { content: r.content, stopReason: "end_turn" };
    },
  };
}

describe("TeamJobRegistry", () => {
  it("tracks team job lifecycle", () => {
    const reg = new TeamJobRegistry();
    const id = reg.startTeamJob({
      teamName: "demo",
      agents: [
        { id: "a", host: "local" },
        { id: "b", host: "peer://p1" },
      ],
    });
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0]!.status).toBe("running");
    reg.setAgentStatus(id, "a", {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    reg.setAgentStatus(id, "a", {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    reg.setAgentStatus(id, "b", {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    reg.finishTeamJob(id, "completed", 0.1);
    expect(reg.list()[0]!.status).toBe("completed");
    expect(reg.list()[0]!.costUsd).toBe(0.1);
  });

  it("tracks peer submit jobs", () => {
    const reg = new TeamJobRegistry();
    const id = reg.startPeerSubmitJob({
      objective: "do x",
      capabilityTag: "code",
      peerId: "p1",
    });
    reg.finishPeerSubmitJob(id, "completed", 0.02);
    const job = reg.list()[0]!;
    expect(job.status).toBe("completed");
    expect(job.agents[0]!.host).toBe("peer://p1");
  });
});

describe("createPeerUiBackend.teamJobs", () => {
  it("exposes registry jobs over the ACP seam", () => {
    const teamJobRegistry = new TeamJobRegistry();
    teamJobRegistry.startPeerSubmitJob({
      objective: "x",
      capabilityTag: "t",
      peerId: "peer-a",
    });
    const { backend } = createPeerUiBackend({
      registry: new PeerRegistry(),
      connected: [],
      failed: [],
      teamJobRegistry,
    });
    const jobs = backend.teamJobs?.() ?? [];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.agents[0]!.host).toBe("peer://peer-a");
  });
});

describe("createTeamJobTracker + Team.runOnce", () => {
  it("records a completed local team run", async () => {
    const registry = new TeamJobRegistry();
    const tracker = createTeamJobTracker(registry);
    const team = new Team({
      config: {
        name: "tiny",
        agents: [
          {
            id: "solo",
            role: "worker",
            objective: "say hi",
            dependsOn: [],
          },
        ],
      },
      model: scriptedModel([
        { content: [{ type: "text", text: "hi" }] },
      ]),
      ...tracker,
    });
    const result = await team.runOnce();
    expect(result.status).toBe("completed");
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.status).toBe("completed");
    expect(registry.list()[0]!.agents[0]!.status).toBe("completed");
  });
});
