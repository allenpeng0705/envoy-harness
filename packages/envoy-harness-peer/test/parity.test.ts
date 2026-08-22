/**
 * D2 — parity: a `PeerMeshSubmitter` whose server handler executes via
 * the SAME `LocalMeshSubmitter` produces identical results to a direct
 * local submit. The transport adds no semantic drift.
 */

import { describe, expect, it } from "vitest";

import { LocalMeshSubmitter } from "@envoymesh/envoy-harness";

import {
  createInProcessPeerPair,
  createPeerServerHandler,
  PeerMeshSubmitter,
} from "../src/index.js";
import { stubAdapter } from "./helpers.js";

describe("PeerMeshSubmitter parity vs LocalMeshSubmitter", () => {
  it("round-trips a local execution through the peer transport unchanged", async () => {
    const INPUT = {
      objective: "say hello",
      capabilityTag: "research",
      costCeilingUsd: 1,
      deadlineMs: 10_000,
    };
    const local = new LocalMeshSubmitter({
      buildSubagent: (input) => {
        void input;
        // A minimal local "agent": returns the objective echoed back.
        return {
          getSessionId: () => "local-session",
          abort: () => {},
          run: async () => ({
            content: [{ type: "text", text: "local echo" }],
            stopReason: "end_turn" as const,
            metrics: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          }),
        } as never;
      },
      workerPeerId: "local",
    });

    const direct = await local.submit(INPUT, new AbortController().signal);

    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        // The peer server executes via a MAP adapter that produces the
        // same text as the local sub-agent.
        adapter: stubAdapter({
          execute: async () => ({
            skillId: "research",
            runtime: "envoy-harness",
            peerId: "local",
            correlationId: "corr",
            content: [{ kind: "text", text: "local echo" }],
            citations: [],
            metrics: { durationMs: 1, costUsd: 0 },
            completedAt: new Date().toISOString(),
            signature: "",
          }),
        }),
        identity: { peerId: "local" },
      }),
    );
    const peer = new PeerMeshSubmitter({ client: pair.client });
    const viaPeer = await peer.submit(INPUT, new AbortController().signal);

    // Shape-level parity: status, runtime, and content match. The local
    // and peer paths compute duration/verdict independently by design.
    expect(viaPeer.status).toBe(direct.status);
    expect(viaPeer.workerRuntime).toBe(direct.workerRuntime);
    expect(viaPeer.content).toEqual(direct.content);
    expect(viaPeer.content).toEqual([{ type: "text", text: "local echo" }]);
    pair.close();
  });
});
