/**
 * D6 — a mesh `RemoteMeshSubmitter` over the standalone peer protocol:
 * the peer cluster is a mesh node's execution pool (Pattern A).
 */

import { describe, expect, it } from "vitest";

import type { AgentAdapter } from "@envoymesh/agent-adapter";
import {
  createInProcessPeerPair,
  createPeerServerHandler,
  PeerRegistry,
} from "@envoymesh/envoy-harness-peer";
import type { SubagentInput } from "@envoymesh/envoy-harness";

import {
  createPeerRemoteSubmitterTransport,
  RemoteMeshSubmitter,
} from "../src/index.js";

const INPUT: SubagentInput = {
  objective: "research feasibility",
  capabilityTag: "research",
  costCeilingUsd: 1,
  deadlineMs: 10_000,
};

function stubPeerAdapter(): AgentAdapter {
  return {
    runtime: "envoy-harness",
    describeSkills: () => [],
    buildManifest: async () => ({}) as never,
    execute: async () => ({
      skillId: "research",
      runtime: "envoy-harness",
      peerId: "p1",
      correlationId: "corr",
      content: [{ kind: "text", text: "peer did the work" }],
      citations: [],
      metrics: { durationMs: 3, costUsd: 0 },
      completedAt: new Date().toISOString(),
      signature: "peer-sig",
    }),
    verify: async () => [{ kind: "pass", score: 1, confidence: "high" }],
  };
}

describe("RemoteMeshSubmitter over the peer transport (D6)", () => {
  it("submits to the peer cluster through the RemoteSubmitterTransport seam", async () => {
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubPeerAdapter(),
        identity: { peerId: "p1", model: "claude-instant" },
      }),
    );
    const registry = new PeerRegistry();
    registry.register({ id: "p1", client: pair.client, model: "claude-instant" });

    const submitter = new RemoteMeshSubmitter({
      transport: createPeerRemoteSubmitterTransport(registry),
      targetPeerId: "p1",
    });
    const result = await submitter.submit(INPUT, new AbortController().signal);

    expect(result.content).toEqual([{ type: "text", text: "peer did the work" }]);
    // The peer's signature rides through (v1 passthrough; envelope
    // verification is v2).
    expect(result.signature).toBe("peer-sig");
    pair.close();
  });

  it("throws a clear error when the target peer is not in the registry", async () => {
    const registry = new PeerRegistry();
    const submitter = new RemoteMeshSubmitter({
      transport: createPeerRemoteSubmitterTransport(registry),
      targetPeerId: "missing",
    });
    await expect(
      submitter.submit(INPUT, new AbortController().signal),
    ).rejects.toThrow(/no peer for target "missing"/);
  });
});
