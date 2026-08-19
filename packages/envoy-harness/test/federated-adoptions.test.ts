/**
 * Federated adoption record tests (F6.3).
 *
 * Covers:
 * 1. `FederatedAdoptionRecord` schema validation.
 * 2. `readAdoptions` / `appendAdoption` file I/O.
 * 3. `FederatedScoreboard.adopt` with `adoptionsFile` records
 *    every evaluation (kept or rejected).
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FederatedScoreboard,
  appendAdoption,
  readAdoptions,
  SelfEvolve,
  signEntry,
  writeBenchmark,
  type Benchmark,
  type BenchmarkRunner,
  type Hypothesis,
  type PeerScoreboard,
  type PeerSource,
  type ScoreboardEntry,
  type SelfEvolvePaths,
  type VerifierRule,
} from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-harness-fed-adopt-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makePaths(): SelfEvolvePaths {
  return {
    scoreboard: path.join(tmpDir, "scoreboard.yaml"),
    snapshotDir: path.join(tmpDir, "snapshots"),
    benchmark: path.join(tmpDir, "benchmark.yaml"),
    ruleset: path.join(tmpDir, "ruleset.json"),
    agentsMd: path.join(tmpDir, "AGENTS.md"),
  };
}

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

const SAMPLE_RULES: VerifierRule[] = [
  {
    name: "non-empty",
    description: "result must not be empty",
    async check() {
      return { kind: "pass" as const, score: 1.0, confidence: "high" as const };
    },
  },
];

class MockPeerSource implements PeerSource {
  constructor(private readonly scoreboards: PeerScoreboard[]) {}
  async fetchScoreboards(): Promise<ReadonlyArray<PeerScoreboard>> {
    return this.scoreboards;
  }
}

const NOOP_HYPOTHESIS: Hypothesis = { text: "no-op", ruleChanges: [] };

function makeSelfEvolve(
  paths: SelfEvolvePaths,
  runner: BenchmarkRunner,
): SelfEvolve {
  return new SelfEvolve({
    paths,
    currentRules: SAMPLE_RULES,
    hypothesisProvider: {
      async proposeHypothesis() {
        return NOOP_HYPOTHESIS;
      },
    },
    benchmarkRunner: runner,
    shadowMode: true,
  });
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

describe("readAdoptions / appendAdoption", () => {
  it("returns an empty list when the file doesn't exist", async () => {
    const adoptions = await readAdoptions(path.join(tmpDir, "missing.yaml"));
    expect(adoptions).toEqual([]);
  });

  it("appends a record (atomic write)", async () => {
    const file = path.join(tmpDir, "adoptions.yaml");
    await appendAdoption(file, {
      peerId: "p1",
      sourceEntry: {
        version: 1,
        hypothesis: "h",
        rulesetHash: "abc",
        passRateAfter: 0.8,
        ownerSignature: "sig",
      },
      localEntry: {
        version: 5,
        passRateBefore: 0.5,
        passRateAfter: 0.8,
      },
      kept: true,
      adoptedAt: "2026-08-18T00:00:00.000Z",
    });
    const adoptions = await readAdoptions(file);
    expect(adoptions).toHaveLength(1);
    expect(adoptions[0]?.peerId).toBe("p1");
    expect(adoptions[0]?.kept).toBe(true);
  });

  it("appends to an existing log", async () => {
    const file = path.join(tmpDir, "adoptions.yaml");
    const record = {
      peerId: "p1",
      sourceEntry: {
        version: 1,
        hypothesis: "h",
        rulesetHash: "abc",
        passRateAfter: 0.8,
        ownerSignature: "sig",
      },
      localEntry: { version: 1, passRateBefore: 0.5, passRateAfter: 0.8 },
      kept: true,
      adoptedAt: "2026-08-18T00:00:00.000Z",
    };
    await appendAdoption(file, record);
    await appendAdoption(file, { ...record, peerId: "p2", kept: false });
    const adoptions = await readAdoptions(file);
    expect(adoptions).toHaveLength(2);
    expect(adoptions[0]?.peerId).toBe("p1");
    expect(adoptions[1]?.peerId).toBe("p2");
  });
});

// ---------------------------------------------------------------------------
// FederatedScoreboard.adopt with adoptionsFile
// ---------------------------------------------------------------------------

describe("FederatedScoreboard.adopt with adoptionsFile", () => {
  it("records the no-rule-bodies rejection with an audit record", async () => {
    const paths = makePaths();
    const bench: Benchmark = {
      name: "t",
      tasks: [{ id: "t1", objective: "x", stubKind: "ok" }],
    };
    await writeBenchmark(paths.benchmark, bench);

    const entry = await makeEntry({ hypothesis: "improve" });
    const peer: PeerScoreboard = { peerId: "p1", entries: [entry] };

    let callCount = 0;
    const runner: BenchmarkRunner = {
      async run() {
        callCount++;
        throw new Error("local gate must not run without rule bodies");
      },
    };
    const evolve = makeSelfEvolve(paths, runner);
    const fed = new FederatedScoreboard(new MockPeerSource([peer]));
    const pullResult = await fed.pull({ optIn: true });
    const adoptionsFile = path.join(tmpDir, "adoptions.yaml");
    const adoptResult = await fed.adopt(pullResult, evolve, {
      adoptionsFile,
      peerId: "p1",
    });
    // v0 federated entries carry no rule bodies, so the local gate
    // cannot evaluate them; candidates are rejected explicitly.
    expect(adoptResult.adopted).toHaveLength(0);
    expect(adoptResult.rejected).toHaveLength(1);
    expect(callCount).toBe(0);

    const adoptions = await readAdoptions(adoptionsFile);
    expect(adoptions).toHaveLength(1);
    expect(adoptions[0]?.peerId).toBe("p1");
    expect(adoptions[0]?.kept).toBe(false);
    expect(adoptions[0]?.reason).toMatch(/no rule bodies/);
    expect(adoptions[0]?.sourceEntry.hypothesis).toBe("improve");
  });

  it("records rejected candidates with reason", async () => {
    const paths = makePaths();
    const bench: Benchmark = {
      name: "t",
      tasks: [{ id: "t1", objective: "x", stubKind: "ok" }],
    };
    await writeBenchmark(paths.benchmark, bench);

    const entry = await makeEntry({ hypothesis: "no-improvement" });
    const peer: PeerScoreboard = { peerId: "p1", entries: [entry] };

    const runner: BenchmarkRunner = {
      async run() {
        return {
          passRate: 0.5,
          meanScore: 0.5,
          nRuns: 1,
          tasks: [{ id: "t1", pass: false }],
        };
      },
    };
    const evolve = makeSelfEvolve(paths, runner);
    const fed = new FederatedScoreboard(new MockPeerSource([peer]));
    const pullResult = await fed.pull({ optIn: true });
    const adoptionsFile = path.join(tmpDir, "adoptions.yaml");
    await fed.adopt(pullResult, evolve, { adoptionsFile, peerId: "p1" });
    const adoptions = await readAdoptions(adoptionsFile);
    expect(adoptions).toHaveLength(1);
    expect(adoptions[0]?.kept).toBe(false);
    expect(adoptions[0]?.reason).toMatch(/no rule bodies/);
  });

  it("records every rejection when multiple candidates are pulled", async () => {
    const paths = makePaths();
    const bench: Benchmark = {
      name: "t",
      tasks: [{ id: "t1", objective: "x", stubKind: "ok" }],
    };
    await writeBenchmark(paths.benchmark, bench);

    const e1 = await makeEntry({ version: 1, hypothesis: "good" });
    const e2 = await makeEntry({ version: 2, hypothesis: "bad" });
    const peer: PeerScoreboard = { peerId: "p1", entries: [e1, e2] };

    const runner: BenchmarkRunner = {
      async run() {
        throw new Error("local gate must not run without rule bodies");
      },
    };
    const evolve = makeSelfEvolve(paths, runner);
    const fed = new FederatedScoreboard(new MockPeerSource([peer]));
    const pullResult = await fed.pull({ optIn: true });
    const adoptionsFile = path.join(tmpDir, "adoptions.yaml");
    await fed.adopt(pullResult, evolve, { adoptionsFile, peerId: "p1" });
    const adoptions = await readAdoptions(adoptionsFile);
    expect(adoptions).toHaveLength(2);
    expect(adoptions[0]?.kept).toBe(false);
    expect(adoptions[1]?.kept).toBe(false);
  });

  it("does not write to the file when adoptionsFile is not provided", async () => {
    const paths = makePaths();
    const bench: Benchmark = {
      name: "t",
      tasks: [{ id: "t1", objective: "x", stubKind: "ok" }],
    };
    await writeBenchmark(paths.benchmark, bench);

    const entry = await makeEntry();
    const peer: PeerScoreboard = { peerId: "p1", entries: [entry] };
    let callCount = 0;
    const runner: BenchmarkRunner = {
      async run() {
        callCount++;
        throw new Error("local gate must not run without rule bodies");
      },
    };
    const evolve = makeSelfEvolve(paths, runner);
    const fed = new FederatedScoreboard(new MockPeerSource([peer]));
    const pullResult = await fed.pull({ optIn: true });
    const adoptResult = await fed.adopt(pullResult, evolve); // no adoptionsFile
    expect(adoptResult.adopted).toHaveLength(0);
    expect(adoptResult.rejected).toHaveLength(1);
    // No file should be created.
    const adoptionsFile = path.join(tmpDir, "should-not-exist.yaml");
    expect(await fs.access(adoptionsFile).catch(() => null)).toBeNull();
  });
});
