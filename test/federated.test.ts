/**
 * Federated scoreboard tests (§13.3, F6.1).
 *
 * Covers F6.1 only: the PeerSource seam, the filter+verify
 * pass, and the opt-in default. The local 5-step gate
 * (F6.2) and adoption records (F6.3) land in separate
 * sub-chunks; their tests live in their own files.
 *
 * **Test isolation:** every test uses a fresh
 * `FederatedScoreboard` with a fresh `PeerSource`. No
 * shared state.
 */

import { describe, expect, it } from "vitest";

import {
  FederatedScoreboard,
  LocalPeerSource,
  signEntry,
  type PeerScoreboard,
  type PeerSource,
  type ScoreboardEntry,
} from "../src/index.js";

/** Build a properly-signed scoreboard entry for tests. */
async function makeEntry(
  overrides: Partial<Omit<ScoreboardEntry, "ownerSignature">> = {},
): Promise<ScoreboardEntry> {
  const base = {
    version: 1,
    hypothesis: "h",
    rulesetHash: "abc",
    meanScore: 0.8,
    passRateBefore: 0.6,
    passRateAfter: 0.8,
    nRuns: 10,
    status: "kept" as const,
    createdAt: "2026-08-18T00:00:00.000Z",
  };
  const merged = { ...base, ...overrides };
  const sig = await signEntry(merged);
  return { ...merged, ownerSignature: sig };
}

/** Build a peer scoreboard from a list of entries. */
async function makePeer(
  peerId: string,
  entries: ScoreboardEntry[],
): Promise<PeerScoreboard> {
  return { peerId, entries };
}

/** A `PeerSource` that returns the given scoreboards. */
class MockPeerSource implements PeerSource {
  constructor(private readonly scoreboards: PeerScoreboard[]) {}
  async fetchScoreboards(): Promise<ReadonlyArray<PeerScoreboard>> {
    return this.scoreboards;
  }
}

/** A `PeerSource` that throws on fetch. */
class FailingPeerSource implements PeerSource {
  async fetchScoreboards(): Promise<ReadonlyArray<PeerScoreboard>> {
    throw new Error("transport error");
  }
}

// ---------------------------------------------------------------------------
// LocalPeerSource (the v0 default)
// ---------------------------------------------------------------------------

describe("LocalPeerSource", () => {
  it("returns an empty list (no network in v0)", async () => {
    const src = new LocalPeerSource();
    const result = await src.fetchScoreboards();
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FederatedScoreboard.pull — opt-in default
// ---------------------------------------------------------------------------

describe("FederatedScoreboard.pull: opt-in default", () => {
  it("is a no-op when optIn is not set", async () => {
    const peer = await makePeer("p1", [await makeEntry()]);
    const fed = new FederatedScoreboard(new MockPeerSource([peer]));
    const result = await fed.pull();
    expect(result.skipped).toBe(true);
    expect(result.validatedCandidates).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("is a no-op when optIn is false", async () => {
    const peer = await makePeer("p1", [await makeEntry()]);
    const fed = new FederatedScoreboard(new MockPeerSource([peer]));
    const result = await fed.pull({ optIn: false });
    expect(result.skipped).toBe(true);
    expect(result.validatedCandidates).toEqual([]);
  });

  it("queries the source when optIn is true", async () => {
    const peer = await makePeer("p1", [await makeEntry()]);
    const fed = new FederatedScoreboard(new MockPeerSource([peer]));
    const result = await fed.pull({ optIn: true });
    expect(result.skipped).toBe(false);
    expect(result.validatedCandidates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// FederatedScoreboard.pull — filter
// ---------------------------------------------------------------------------

describe("FederatedScoreboard.pull: filter", () => {
  it("drops entries with status !== 'kept'", async () => {
    const kept = await makeEntry({ status: "kept", version: 1 });
    const reverted = await makeEntry({ status: "reverted", version: 2 });
    const peer = await makePeer("p1", [kept, reverted]);
    const fed = new FederatedScoreboard(new MockPeerSource([peer]));
    const result = await fed.pull({ optIn: true });
    expect(result.validatedCandidates.map((e) => e.version)).toEqual([1]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("status=reverted");
  });
});

// ---------------------------------------------------------------------------
// FederatedScoreboard.pull — signature verify
// ---------------------------------------------------------------------------

describe("FederatedScoreboard.pull: signature verify", () => {
  it("accepts a properly-signed entry", async () => {
    const entry = await makeEntry();
    const peer = await makePeer("p1", [entry]);
    const fed = new FederatedScoreboard(new MockPeerSource([peer]));
    const result = await fed.pull({ optIn: true });
    expect(result.validatedCandidates).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  it("rejects an entry with a tampered signature", async () => {
    const entry = await makeEntry();
    // Tamper with the hypothesis after signing.
    const tampered: ScoreboardEntry = {
      ...entry,
      hypothesis: "totally-different-hypothesis",
    };
    const peer = await makePeer("p1", [tampered]);
    const fed = new FederatedScoreboard(new MockPeerSource([peer]));
    const result = await fed.pull({ optIn: true });
    expect(result.validatedCandidates).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("signature-invalid");
  });

  it("rejects an entry with a zeroed signature", async () => {
    const entry = await makeEntry();
    const zeroed: ScoreboardEntry = { ...entry, ownerSignature: "0".repeat(64) };
    const peer = await makePeer("p1", [zeroed]);
    const fed = new FederatedScoreboard(new MockPeerSource([peer]));
    const result = await fed.pull({ optIn: true });
    expect(result.rejected[0]?.reason).toBe("signature-invalid");
  });
});

// ---------------------------------------------------------------------------
// FederatedScoreboard.pull — fan-in
// ---------------------------------------------------------------------------

describe("FederatedScoreboard.pull: fan-in across peers", () => {
  it("aggregates entries from multiple peers", async () => {
    const p1 = await makePeer("p1", [await makeEntry({ version: 1 })]);
    const p2 = await makePeer("p2", [await makeEntry({ version: 2 })]);
    const fed = new FederatedScoreboard(new MockPeerSource([p1, p2]));
    const result = await fed.pull({ optIn: true });
    expect(result.validatedCandidates.map((e) => e.version).sort()).toEqual([1, 2]);
  });

  it("respects maxCandidates (caps the total)", async () => {
    const entries = await Promise.all(
      [1, 2, 3, 4, 5].map((v) => makeEntry({ version: v })),
    );
    const peer = await makePeer("p1", entries);
    const fed = new FederatedScoreboard(new MockPeerSource([peer]));
    const result = await fed.pull({ optIn: true, maxCandidates: 2 });
    expect(result.validatedCandidates).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// FederatedScoreboard.pull — error handling
// ---------------------------------------------------------------------------

describe("FederatedScoreboard.pull: error handling", () => {
  it("does not throw when the PeerSource fails (transport error)", async () => {
    const fed = new FederatedScoreboard(new FailingPeerSource());
    const result = await fed.pull({ optIn: true });
    // The pull is a no-op (skipped: false, no candidates) — the
    // operator can retry. We do NOT throw because a failed pull
    // should not abort the local cycle.
    expect(result.validatedCandidates).toEqual([]);
    expect(result.skipped).toBe(false);
  });
});
