/**
 * D4 — the distributed team runner: a team agent hosted on
 * `peer://<id>` dispatches through `createPeerTeamExecutor`.
 */

import { describe, expect, it } from "vitest";

import { Team } from "@envoymesh/envoy-harness";

import {
  createInProcessPeerPair,
  createPeerServerHandler,
  createPeerTeamExecutor,
  PeerRegistry,
} from "../src/index.js";
import { stubAdapter } from "./helpers.js";

describe("distributed team runner (D4)", () => {
  it("dispatches a peer://-hosted agent to the peer and returns its text", async () => {
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter({
          execute: async () => ({
            skillId: "worker",
            runtime: "envoy-harness",
            peerId: "p1",
            correlationId: "team-corr",
            content: [{ kind: "text", text: "peer finished the subtask" }],
            citations: [],
            metrics: { durationMs: 3, costUsd: 0 },
            completedAt: new Date().toISOString(),
            signature: "",
          }),
        }),
        identity: { peerId: "p1", model: "claude-instant" },
      }),
    );
    const registry = new PeerRegistry();
    registry.register({ id: "p1", client: pair.client, model: "claude-instant" });
    const peerExecutor = createPeerTeamExecutor(registry);

    const team = new Team({
      model: {
        async complete() {
          throw new Error("local model must not run for a peer-hosted agent");
        },
      },
      config: {
        name: "distributed",
        agents: [
          {
            id: "a",
            role: "worker",
            objective: "do it",
            dependsOn: [],
            host: "peer://p1",
          },
        ],
      },
      peerExecutor,
    });

    const result = await team.runOnce();
    expect(result.status).toBe("completed");
    expect(result.agents[0]?.finalText).toContain("peer finished the subtask");
    pair.close();
  });

  it("fails clearly when a peer host has no peerExecutor", async () => {
    const team = new Team({
      model: {
        async complete() {
          throw new Error("should not run");
        },
      },
      config: {
        name: "broken",
        agents: [
          {
            id: "a",
            role: "worker",
            objective: "x",
            dependsOn: [],
            host: "peer://p1",
          },
        ],
      },
    });
    const result = await team.runOnce();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("requires TeamOptions.peerExecutor");
  });
});
