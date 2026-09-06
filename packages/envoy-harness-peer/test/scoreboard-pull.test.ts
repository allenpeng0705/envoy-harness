/**
 * R4.11 — federated scoreboard pull: peer A records → peer B pulls →
 * idempotent second pull.
 */

import { describe, expect, it } from "vitest";

import type { VerdictEntry } from "@envoymesh/protocol";

import {
  createInProcessPeerPair,
  createPeerServerHandler,
  PeerRegistry,
  PeerScoreboard,
  pullPeerScoreboards,
} from "../src/index.js";
import { stubAdapter } from "./helpers.js";

function entry(
  partial: Partial<VerdictEntry> &
    Pick<VerdictEntry, "chainId" | "subtaskId" | "issuedBy">,
): VerdictEntry {
  return {
    workerPeerId: "w1",
    workerRuntime: "envoy-harness",
    skillId: "research",
    verdict: { kind: "pass", score: 0.9, confidence: "high" },
    source: "llm",
    verifierModel: "claude-instant",
    issuedAt: "2026-09-06T00:00:00.000Z",
    signature: "",
    ...partial,
  };
}

describe("R4.11 federated scoreboard pull", () => {
  it("lists remote entries, merges into local, and is idempotent", async () => {
    const remoteBoard = new PeerScoreboard();
    remoteBoard.record(
      entry({ chainId: "c1", subtaskId: "s1", issuedBy: "orch-a" }),
    );
    remoteBoard.record(
      entry({
        chainId: "c1",
        subtaskId: "s2",
        issuedBy: "orch-a",
        verdict: { kind: "fail", reason: "missed", rollback: true },
      }),
    );

    const remotePair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter({}),
        identity: { peerId: "peer-a", model: "deepseek-chat" },
        scoreboard: remoteBoard,
      }),
    );
    const localBoard = new PeerScoreboard();
    const registry = new PeerRegistry();
    registry.register({
      id: "peer-a",
      client: remotePair.client,
      model: "deepseek-chat",
    });

    const first = await pullPeerScoreboards({
      registry,
      local: localBoard,
    });
    expect(first.peersOk).toBe(1);
    expect(first.merge.added).toBe(2);
    expect(first.merge.skipped).toBe(0);
    expect(localBoard.list()).toHaveLength(2);

    const second = await pullPeerScoreboards({
      registry,
      local: localBoard,
    });
    expect(second.merge.added).toBe(0);
    expect(second.merge.skipped).toBe(2);
    expect(localBoard.list()).toHaveLength(2);

    // Direct list RPC sanity.
    const listed = await remotePair.client.listScoreboard();
    expect(listed).toHaveLength(2);

    remotePair.close();
  });

  it("returns empty list when peer has no scoreboard wired", async () => {
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter({}),
        identity: { peerId: "bare" },
      }),
    );
    expect(await pair.client.listScoreboard()).toEqual([]);
    pair.close();
  });

  it("merges by (chainId, subtaskId, issuedBy) key", () => {
    const board = new PeerScoreboard();
    const a = entry({ chainId: "c", subtaskId: "s", issuedBy: "x" });
    expect(board.record(a)).toBe(true);
    expect(board.record({ ...a })).toBe(false);
    expect(
      board.merge([
        a,
        entry({ chainId: "c", subtaskId: "s", issuedBy: "y" }),
      ]),
    ).toEqual({ added: 1, skipped: 1 });
    expect(board.list()).toHaveLength(2);
  });
});
