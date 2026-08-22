/**
 * D3 — the adapter-backed peer server: MAP execute/verify/manifest + ping
 * identity over the in-process pair.
 */

import { describe, expect, it } from "vitest";

import {
  createInProcessPeerPair,
  createPeerServerHandler,
} from "../src/index.js";
import { signedResult, stubAdapter } from "./helpers.js";

describe("adapter-backed peer server (MAP-over-JSON-RPC)", () => {
  it("routes execute/verify/manifest/ping to the adapter", async () => {
    let receivedVerifierModel: string | undefined;
    const adapter = stubAdapter({
      execute: async (input) => {
        receivedVerifierModel = input.verifierModel;
        return signedResult({ correlationId: input.correlationId });
      },
    });
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter,
        identity: { peerId: "peer-1", model: "claude-instant" },
      }),
    );

    const ping = await pair.client.ping();
    expect(ping).toEqual({ ok: true, peerId: "peer-1", model: "claude-instant" });

    const executed = await pair.client.execute({
      skillId: "research",
      objective: "verify this",
      inputArtifacts: [],
      costCeilingUsd: 1,
      deadlineMs: 10_000,
      correlationId: "corr-v116",
      signal: new AbortController().signal,
      verifierModel: "anthropic:claude-instant",
    });
    expect(executed.correlationId).toBe("corr-v116");
    // The v1.16 per-call model override travels over the wire.
    expect(receivedVerifierModel).toBe("anthropic:claude-instant");

    const verdicts = await pair.client.verify({
      result: executed,
      objective: "verify this",
    });
    expect(verdicts[0]).toMatchObject({ kind: "pass" });

    const manifest = await pair.client.manifest({
      peerId: "peer-1",
      ownerId: "owner-1",
      reputationBySkill: {},
    });
    expect(manifest.peerId).toBe("peer-1");
    expect(manifest.runtime).toBe("envoy-harness");

    pair.close();
  });

  it("includes a combined verdict when verifyAfterExecute is enabled", async () => {
    const adapter = stubAdapter({
      execute: async (input) =>
        signedResult({ correlationId: input.correlationId }),
      verify: async () => [
        { kind: "fail", reason: "answer is wrong", rollback: true },
      ],
    });
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter,
        identity: { peerId: "peer-1", model: "claude-instant" },
        verifyAfterExecute: true,
      }),
    );

    const response = await pair.client.executeWithVerdict({
      skillId: "research",
      objective: "verify this",
      inputArtifacts: [],
      costCeilingUsd: 1,
      deadlineMs: 10_000,
      correlationId: "corr-verify",
      signal: new AbortController().signal,
    });
    expect(response.result.correlationId).toBe("corr-verify");
    expect(response.verdict).toEqual({
      kind: "fail",
      reason: "answer is wrong",
      rollback: true,
    });
    pair.close();
  });

  it("omits the verdict by default (client falls back to the placeholder)", async () => {
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter(),
        identity: { peerId: "peer-1" },
      }),
    );
    const response = await pair.client.executeWithVerdict({
      skillId: "research",
      objective: "x",
      inputArtifacts: [],
      costCeilingUsd: 1,
      deadlineMs: 10_000,
      correlationId: "corr-plain",
      signal: new AbortController().signal,
    });
    expect(response.verdict).toBeUndefined();
    expect(response.result.correlationId).toBe("corr-plain");
    pair.close();
  });

  it("still succeeds without a verdict when the post-execute verifier throws", async () => {
    const adapter = stubAdapter({
      execute: async (input) =>
        signedResult({ correlationId: input.correlationId }),
      verify: async () => {
        throw new Error("verifier down");
      },
    });
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter,
        identity: { peerId: "peer-1" },
        verifyAfterExecute: true,
      }),
    );

    const response = await pair.client.executeWithVerdict({
      skillId: "research",
      objective: "x",
      inputArtifacts: [],
      costCeilingUsd: 1,
      deadlineMs: 10_000,
      correlationId: "corr-vfail",
      signal: new AbortController().signal,
    });
    // A verifier hiccup must not discard a completed result.
    expect(response.result.correlationId).toBe("corr-vfail");
    expect(response.verdict).toBeUndefined();
    pair.close();
  });
});
