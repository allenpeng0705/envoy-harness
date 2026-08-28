/**
 * D5 — cross-instance verification (different-model peers) + the local
 * `PeerScoreboard` over `VerdictEntry` records.
 */

import { describe, expect, it } from "vitest";

import type { Verdict } from "@envoymesh/protocol";

import {
  combinePeerVerdicts,
  createCrossInstanceVerifier,
  createInProcessPeerPair,
  createPeerServerHandler,
  createVerifiedScoreKeeper,
  PeerRegistry,
  PeerScoreboard,
} from "../src/index.js";
import { signedResult, stubAdapter } from "./helpers.js";

function peer(id: string, model: string, verifyVerdicts: Verdict[]) {
  const pair = createInProcessPeerPair(
    createPeerServerHandler({
      adapter: stubAdapter({ verify: async () => verifyVerdicts }),
      identity: { peerId: id, model },
    }),
  );
  return { id, model, client: pair.client, pair };
}

describe("cross-instance verification (D5)", () => {
  it("routes the verify to the peer with the requested model", async () => {
    const deepseek = peer("p-deepseek", "deepseek-chat", []);
    const claude = peer("p-claude", "claude-instant", [
      { kind: "pass", score: 0.95, confidence: "high" },
    ]);
    const registry = new PeerRegistry();
    registry.register(deepseek);
    registry.register(claude);
    const verifier = createCrossInstanceVerifier(registry);

    const outcome = await verifier({
      result: signedResult(),
      objective: "verify this",
      verifierModel: "claude-instant",
    });
    expect(outcome.verifierPeerId).toBe("p-claude");
    expect(outcome.verifierModel).toBe("claude-instant");
    expect(outcome.verdicts[0]).toMatchObject({ kind: "pass", score: 0.95 });
    deepseek.pair.close();
    claude.pair.close();
  });

  it("throws when no peer matches the requested model", async () => {
    const p = peer("p", "deepseek-chat", []);
    const registry = new PeerRegistry();
    registry.register(p);
    const verifier = createCrossInstanceVerifier(registry);
    await expect(
      verifier({ result: signedResult(), objective: "x", verifierModel: "none" }),
    ).rejects.toThrow(/no peer available/);
    p.pair.close();
  });
});

describe("PeerScoreboard + combined verify-and-record (D5)", () => {
  it("records VerdictEntrys and aggregates reputation", async () => {
    const scoreboard = new PeerScoreboard();
    scoreboard.record({
      chainId: "c1",
      subtaskId: "s1",
      workerPeerId: "w1",
      workerRuntime: "envoy-harness",
      skillId: "research",
      verdict: { kind: "pass", score: 1, confidence: "high" },
      source: "llm",
      verifierModel: "claude-instant",
      issuedBy: "orch",
      issuedAt: new Date().toISOString(),
      signature: "",
    });
    scoreboard.record({
      chainId: "c1",
      subtaskId: "s2",
      workerPeerId: "w1",
      workerRuntime: "envoy-harness",
      skillId: "research",
      verdict: { kind: "fail", reason: "missed the objective", rollback: true },
      source: "llm",
      verifierModel: "deepseek-chat",
      issuedBy: "orch",
      issuedAt: new Date().toISOString(),
      signature: "",
    });
    const rep = scoreboard.reputationFor("w1", "research");
    expect(rep.passCount).toBe(1);
    expect(rep.failCount).toBe(1);
    expect(rep.score).toBe(0.5);
    expect(scoreboard.list()).toHaveLength(2);
  });

  it("verifies across a different-model peer and records the entry", async () => {
    const claude = peer("p-claude", "claude-instant", [
      { kind: "pass", score: 0.9, confidence: "high" },
    ]);
    const registry = new PeerRegistry();
    registry.register(claude);
    const scoreboard = new PeerScoreboard();
    const keep = createVerifiedScoreKeeper({
      verifier: createCrossInstanceVerifier(registry),
      scoreboard,
      orchestratorPeerId: "orch-1",
    });

    const entry = await keep({
      result: signedResult({ peerId: "w1" }),
      objective: "verify the worker result",
      verifierModel: "claude-instant",
      workerPeerId: "w1",
      workerRuntime: "envoy-harness",
      skillId: "research",
      chainId: "c1",
      subtaskId: "s1",
    });
    expect(entry.verifierModel).toBe("claude-instant");
    expect(entry.verdict.kind).toBe("pass");
    expect(entry.issuedBy).toBe("orch-1");
    expect(scoreboard.reputationFor("w1", "research").score).toBe(0.9);
    claude.pair.close();
  });

  it("combines verdicts with the mesh rule (OR-pass, AND-fail, else disputed)", () => {
    expect(
      combinePeerVerdicts([{ kind: "fail", reason: "x", rollback: true }]).kind,
    ).toBe("fail");
    expect(
      combinePeerVerdicts([
        { kind: "fail", reason: "x", rollback: true },
        { kind: "pass", score: 1, confidence: "high" },
      ]).kind,
    ).toBe("pass");
    expect(combinePeerVerdicts([]).kind).toBe("disputed");
  });
});
