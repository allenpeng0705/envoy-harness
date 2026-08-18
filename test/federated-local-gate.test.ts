/**
 * Federated scoreboard local 5-step gate tests (F6.2).
 *
 * Covers:
 * 1. `SelfEvolve.runOneCycleAgainst` — runs the 5-step protocol
 *    with a fixed (external) hypothesis. Skips the provider
 *    call. Never commits. Tags the hypothesis text with
 *    `[federated]`.
 * 2. `FederatedScoreboard.adopt` — for each validated candidate,
 *    calls `runOneCycleAgainst`. Returns the adopted set
 *    (those that passed the local gate) and the rejected
 *    set (those that didn't).
 *
 * **Test isolation:** every test uses fresh temp dirs,
 * fresh `FederatedScoreboard`, and a stub `SelfEvolve`.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FederatedScoreboard,
  readScoreboard,
  SelfEvolve,
  signEntry,
  writeBenchmark,
  type Benchmark,
  type BenchmarkRunner,
  type Hypothesis,
  type HypothesisProvider,
  type PeerScoreboard,
  type PeerSource,
  type ScoreboardEntry,
  type SelfEvolvePaths,
  type VerifierRule,
} from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-harness-fed-"));
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
    hypothesis: "stricter check",
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

/** Build a SelfEvolve that uses the given provider + runner. */
function makeSelfEvolve(
  paths: SelfEvolvePaths,
  provider: HypothesisProvider,
  runner: BenchmarkRunner,
  opts: { shadowMode?: boolean } = {},
): SelfEvolve {
  return new SelfEvolve({
    paths,
    currentRules: SAMPLE_RULES,
    hypothesisProvider: provider,
    benchmarkRunner: runner,
    shadowMode: opts.shadowMode ?? true,
  });
}

// ---------------------------------------------------------------------------
// SelfEvolve.runOneCycleAgainst
// ---------------------------------------------------------------------------

describe("SelfEvolve.runOneCycleAgainst", () => {
  it("runs the 5-step protocol with the given hypothesis (no provider call)", async () => {
    const paths = makePaths();
    const bench: Benchmark = {
      name: "t",
      tasks: [{ id: "t1", objective: "x", stubKind: "ok" }],
    };
    await writeBenchmark(paths.benchmark, bench);

    // Provider would return null; we shouldn't call it because
    // an external hypothesis was given.
    let providerCalled = false;
    const provider: HypothesisProvider = {
      async proposeHypothesis() {
        providerCalled = true;
        return NOOP_HYPOTHESIS;
      },
    };
    let callCount = 0;
    const runner: BenchmarkRunner = {
      async run() {
        callCount++;
        return {
          passRate: callCount === 1 ? 0.5 : 1.0,
          meanScore: callCount === 1 ? 0.5 : 1.0,
          nRuns: 1,
          tasks: [{ id: "t1", pass: callCount === 2 }],
        };
      },
    };
    const evolve = makeSelfEvolve(paths, provider, runner);
    const result = await evolve.runOneCycleAgainst({
      text: "external hypothesis",
      ruleChanges: [],
    });
    expect(providerCalled).toBe(false);
    expect(result.kept).toBe(true);
    // The hypothesis text in the entry is prefixed with [federated].
    expect(result.entry.hypothesis).toBe("[federated] external hypothesis");
  });

  it("never commits even when kept (federated cycles don't write ruleset)", async () => {
    const paths = makePaths();
    const bench: Benchmark = {
      name: "t",
      tasks: [{ id: "t1", objective: "x", stubKind: "ok" }],
    };
    await writeBenchmark(paths.benchmark, bench);

    // Pre-populate the ruleset with a marker; the federated
    // cycle should not touch it.
    await fs.mkdir(path.dirname(paths.ruleset), { recursive: true });
    await fs.writeFile(paths.ruleset, "INITIAL", "utf8");

    const provider: HypothesisProvider = {
      async proposeHypothesis() {
        return NOOP_HYPOTHESIS;
      },
    };
    let callCount = 0;
    const runner: BenchmarkRunner = {
      async run() {
        callCount++;
        return {
          passRate: callCount === 1 ? 0.5 : 1.0,
          meanScore: 0.7,
          nRuns: 1,
          tasks: [{ id: "t1", pass: callCount === 2 }],
        };
      },
    };
    const evolve = makeSelfEvolve(paths, provider, runner, { shadowMode: false });
    const result = await evolve.runOneCycleAgainst({
      text: "x",
      ruleChanges: [],
    });
    expect(result.kept).toBe(true);
    // Live ruleset untouched.
    const live = await fs.readFile(paths.ruleset, "utf8");
    expect(live).toBe("INITIAL");
  });

  it("records the cycle in the main scoreboard (counter advances)", async () => {
    const paths = makePaths();
    const bench: Benchmark = {
      name: "t",
      tasks: [{ id: "t1", objective: "x", stubKind: "ok" }],
    };
    await writeBenchmark(paths.benchmark, bench);

    const provider: HypothesisProvider = {
      async proposeHypothesis() { return NOOP_HYPOTHESIS; },
    };
    const runner: BenchmarkRunner = {
      async run() {
        return { passRate: 1.0, meanScore: 1.0, nRuns: 1, tasks: [{ id: "t1", pass: true }] };
      },
    };
    const evolve = makeSelfEvolve(paths, provider, runner);
    await evolve.runOneCycleAgainst({ text: "x", ruleChanges: [] });
    const board = await readScoreboard(paths.scoreboard);
    expect(board).toHaveLength(1);
    expect(board[0]?.hypothesis).toBe("[federated] x");
  });
});

// ---------------------------------------------------------------------------
// FederatedScoreboard.adopt
// ---------------------------------------------------------------------------

describe("FederatedScoreboard.adopt", () => {
  it("returns skipped when the upstream pull was skipped", async () => {
    const fed = new FederatedScoreboard(new MockPeerSource([]));
    const result = await fed.adopt(
      { validatedCandidates: [], rejected: [], skipped: true },
      // The SelfEvolve is irrelevant when skipped; supply a stub.
      // (If adopt tries to call it, it'll fail loudly.)
      {} as SelfEvolve,
    );
    expect(result.skipped).toBe(true);
    expect(result.adopted).toEqual([]);
  });

  it("calls the local gate for each validated candidate", async () => {
    const paths = makePaths();
    const bench: Benchmark = {
      name: "t",
      tasks: [{ id: "t1", objective: "x", stubKind: "ok" }],
    };
    await writeBenchmark(paths.benchmark, bench);

    const e1 = await makeEntry({ version: 1, hypothesis: "first" });
    const e2 = await makeEntry({ version: 2, hypothesis: "second" });
    const peer: PeerScoreboard = { peerId: "p1", entries: [e1, e2] };

    let callCount = 0;
    const runner: BenchmarkRunner = {
      async run() {
        callCount++;
        // Each cycle: baseline pass 0.5, candidate pass 1.0.
        // Both candidates strictly improve → both adopted.
        const isBaseline = callCount % 2 === 1;
        return {
          passRate: isBaseline ? 0.5 : 1.0,
          meanScore: isBaseline ? 0.5 : 1.0,
          nRuns: 1,
          tasks: [{ id: "t1", pass: !isBaseline }],
        };
      },
    };
    const evolve = makeSelfEvolve(
      paths,
      { async proposeHypothesis() { return NOOP_HYPOTHESIS; } },
      runner,
    );
    const fed = new FederatedScoreboard(new MockPeerSource([peer]));
    const pullResult = await fed.pull({ optIn: true });
    expect(pullResult.validatedCandidates).toHaveLength(2);
    const adoptResult = await fed.adopt(pullResult, evolve);
    // Both candidates were evaluated by the local gate.
    // callCount: 2 candidates × 2 (baseline + candidate) = 4.
    expect(callCount).toBe(4);
    expect(adoptResult.adopted).toHaveLength(2);
  });

  it("splits adopted vs rejected based on the local pass rate", async () => {
    const paths = makePaths();
    const bench: Benchmark = {
      name: "t",
      tasks: [{ id: "t1", objective: "x", stubKind: "ok" }],
    };
    await writeBenchmark(paths.benchmark, bench);

    const e1 = await makeEntry({ version: 1, hypothesis: "improving" });
    const e2 = await makeEntry({ version: 2, hypothesis: "no-improvement" });
    const peer: PeerScoreboard = { peerId: "p1", entries: [e1, e2] };

    let callCount = 0;
    const runner: BenchmarkRunner = {
      async run() {
        callCount++;
        // First candidate: 0.5 → 1.0 (improving). Second: 0.5 → 0.5 (no change).
        // We need to alternate per candidate. callCount is global;
        // 1 = baseline for e1; 2 = candidate for e1; 3 = baseline for e2; 4 = candidate for e2.
        const isBaseline = callCount % 2 === 1;
        const isFirstCycle = callCount <= 2;
        return {
          passRate: isBaseline ? 0.5 : isFirstCycle ? 1.0 : 0.5,
          meanScore: 0.7,
          nRuns: 1,
          tasks: [{ id: "t1", pass: !isBaseline && isFirstCycle }],
        };
      },
    };
    const evolve = makeSelfEvolve(
      paths,
      { async proposeHypothesis() { return NOOP_HYPOTHESIS; } },
      runner,
    );
    const fed = new FederatedScoreboard(new MockPeerSource([peer]));
    const pullResult = await fed.pull({ optIn: true });
    const adoptResult = await fed.adopt(pullResult, evolve);
    expect(adoptResult.adopted).toHaveLength(1);
    expect(adoptResult.adopted[0]?.entry.hypothesis).toBe("improving");
    expect(adoptResult.rejected).toHaveLength(1);
    expect(adoptResult.rejected[0]?.entry.hypothesis).toBe("no-improvement");
  });
});
