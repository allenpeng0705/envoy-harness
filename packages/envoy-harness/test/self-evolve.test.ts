/**
 * SelfEvolve tests (§13 of the design, 5-step protocol).
 *
 * Covers:
 * 1. The contamination guard — `buildHypothesisPrompt` does NOT
 *    include the benchmark, the gold answers, or any private data.
 * 2. `parseHypothesisFromLlm` — JSON shape, malformed input, no-op.
 * 3. `SelfEvolve.runOneCycle` — full happy path with a stub
 *    `HypothesisProvider` and a stub `BenchmarkRunner`.
 * 4. Shadow mode vs commit mode.
 * 5. The 5 steps in order: snapshot → hypothesize → candidate →
 *    evaluate → commit/revert.
 * 6. `DefaultBenchmarkRunner` — stub construction, expectedVerdict.
 *
 * **Test isolation:** every test uses fresh temp dirs and
 * fresh `SelfEvolve` instances.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildHypothesisPrompt,
  DefaultBenchmarkRunner,
  ModelHypothesisProvider,
  parseHypothesisFromLlm,
  SelfEvolve,
  writeBenchmark,
  type Benchmark,
  type BenchmarkRunner,
  type Hypothesis,
  type HypothesisProvider,
  type SelfEvolvePaths,
  type VerifierRule,
} from "../src/index.js";
import { DEFAULT_RULES } from "../src/index.js";
import type { ModelResponse } from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-harness-se-"));
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

function makeBenchmark(tasks: Benchmark["tasks"]): Benchmark {
  return { name: "test", tasks };
}

const SAMPLE_RULES: VerifierRule[] = [
  {
    name: "non-empty",
    description: "result must not be empty",
    async check() { return { kind: "pass" as const, score: 1.0, confidence: "high" as const }; },
  },
  {
    name: "off-topic-fail",
    description: "result must address the objective",
    async check(_result, objective) {
      const text = JSON.stringify(_result.content);
      const hasKeyword = objective
        .split(" ")
        .some((w) => w.length > 3 && text.toLowerCase().includes(w.toLowerCase()));
      return hasKeyword
        ? { kind: "pass" as const, score: 1.0, confidence: "high" as const }
        : { kind: "fail" as const, reason: "off-topic", rollback: false };
    },
  },
];

// ---------------------------------------------------------------------------
// buildHypothesisPrompt — the contamination guard
// ---------------------------------------------------------------------------

describe("buildHypothesisPrompt (contamination guard)", () => {
  it("includes the current rules (name + description only)", () => {
    const prompt = buildHypothesisPrompt({
      currentRules: SAMPLE_RULES,
      recentFailures: [],
    });
    expect(prompt).toContain("non-empty");
    expect(prompt).toContain("result must not be empty");
    expect(prompt).toContain("off-topic-fail");
  });

  it("includes recent failures", () => {
    const prompt = buildHypothesisPrompt({
      currentRules: [],
      recentFailures: [
        {
          version: 1,
          hypothesis: "add a check for X",
          rulesetHash: "abc",
          meanScore: 0.5,
          passRateBefore: 0.6,
          passRateAfter: 0.4,
          nRuns: 10,
          status: "reverted",
          ownerSignature: "sig",
          createdAt: "2026-08-18T00:00:00.000Z",
        },
      ],
    });
    expect(prompt).toContain("add a check for X");
  });

  it("does NOT include any 'benchmark' text in the safe scope", () => {
    // The prompt builder takes only rules + failures. A caller
    // who passes the benchmark by mistake is silently ignored —
    // the function never references it. This test pins that
    // contract.
    const prompt = buildHypothesisPrompt({
      currentRules: SAMPLE_RULES,
      recentFailures: [],
    });
    expect(prompt).not.toMatch(/benchmark/i);
    expect(prompt).not.toMatch(/gold/i);
    expect(prompt).not.toMatch(/rubric/i);
    expect(prompt).not.toMatch(/frozen/i);
  });
});

// ---------------------------------------------------------------------------
// parseHypothesisFromLlm
// ---------------------------------------------------------------------------

describe("parseHypothesisFromLlm", () => {
  function makeResponse(text: string): ModelResponse {
    return {
      content: [{ type: "text", text }],
      stopReason: "end_turn",
    };
  }

  it("parses a well-formed JSON hypothesis", () => {
    const r = parseHypothesisFromLlm(
      makeResponse(JSON.stringify({
        text: "Add a stricter check",
        ruleChanges: [{ name: "x", description: "y" }],
      })),
    );
    expect(r?.text).toBe("Add a stricter check");
    expect(r?.ruleChanges).toHaveLength(1);
    expect(r?.ruleChanges[0]?.name).toBe("x");
  });

  it("extracts JSON from surrounding prose", () => {
    const r = parseHypothesisFromLlm(
      makeResponse(`Here is my proposal: ${JSON.stringify({ text: "x", ruleChanges: [{ name: "a", description: "b" }] })} -- end`),
    );
    expect(r?.text).toBe("x");
  });

  it("returns null on empty ruleChanges (no-op)", () => {
    const r = parseHypothesisFromLlm(
      makeResponse(JSON.stringify({ text: "no actionable", ruleChanges: [] })),
    );
    expect(r).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseHypothesisFromLlm(makeResponse("not json"))).toBeNull();
  });

  it("returns null when text is missing", () => {
    expect(
      parseHypothesisFromLlm(
        makeResponse(JSON.stringify({ ruleChanges: [{ name: "x", description: "y" }] })),
      ),
    ).toBeNull();
  });

  it("returns null when ruleChanges is not an array", () => {
    expect(
      parseHypothesisFromLlm(
        makeResponse(JSON.stringify({ text: "x", ruleChanges: "not-an-array" })),
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SelfEvolve.runOneCycle
// ---------------------------------------------------------------------------

describe("SelfEvolve.runOneCycle", () => {
  it("runs the 5 steps in order and records a kept entry", async () => {
    const paths = makePaths();
    const bench = makeBenchmark([
      { id: "t1", objective: "deploy the database", stubKind: "ok" },
    ]);
    await writeBenchmark(paths.benchmark, bench);

    // Hypothesis provider: always propose a NEW ruleset that
    // is "better" by the benchmark runner's measure.
    const provider: HypothesisProvider = {
      async proposeHypothesis(): Promise<Hypothesis> {
        return {
          text: "stricter off-topic check",
          ruleChanges: SAMPLE_RULES, // same rules, runner still passes
        };
      },
    };

    // The runner: baseline is 0.5, candidate is 1.0 (improvement).
    // The cycle keeps the change because 1.0 > 0.5.
    let callCount = 0;
    const runner: BenchmarkRunner = {
      async run() {
        callCount++;
        const isCandidate = callCount === 2;
        return {
          passRate: isCandidate ? 1.0 : 0.5,
          meanScore: isCandidate ? 1.0 : 0.5,
          nRuns: 1,
          tasks: [{ id: "t1", pass: isCandidate }],
        };
      },
    };

    const evolve = new SelfEvolve({
      paths,
      currentRules: SAMPLE_RULES,
      hypothesisProvider: provider,
      benchmarkRunner: runner,
      shadowMode: false, // allow commit
    });
    const result = await evolve.runOneCycle();
    expect(result.kept).toBe(true);
    expect(result.entry.status).toBe("kept");
    expect(result.entry.version).toBe(1);
    expect(result.entry.hypothesis).toBe("stricter off-topic check");
    // The scoreboard file should have one entry.
    const { readScoreboard } = await import("../src/index.js");
    const board = await readScoreboard(paths.scoreboard);
    expect(board).toHaveLength(1);
  });

  it("reverts when candidate pass rate is not greater than baseline", async () => {
    const paths = makePaths();
    const bench = makeBenchmark([
      { id: "t1", objective: "x", stubKind: "ok" },
    ]);
    await writeBenchmark(paths.benchmark, bench);

    const provider: HypothesisProvider = {
      async proposeHypothesis() {
        return { text: "no improvement", ruleChanges: SAMPLE_RULES };
      },
    };
    let call = 0;
    const runner: BenchmarkRunner = {
      async run() {
        call++;
        // First call (baseline): pass 1.0; second (candidate): pass 0.5.
        // Strictly greater → kept = false.
        return {
          passRate: call === 1 ? 1.0 : 0.5,
          meanScore: call === 1 ? 1.0 : 0.5,
          nRuns: 1,
          tasks: [{ id: "t1", pass: call === 1 }],
        };
      },
    };

    const evolve = new SelfEvolve({
      paths,
      currentRules: SAMPLE_RULES,
      hypothesisProvider: provider,
      benchmarkRunner: runner,
      shadowMode: false,
    });
    const result = await evolve.runOneCycle();
    expect(result.kept).toBe(false);
    expect(result.entry.status).toBe("reverted");
  });

  it("records a no-op entry when the hypothesis is null", async () => {
    const paths = makePaths();
    const bench = makeBenchmark([
      { id: "t1", objective: "x", stubKind: "ok" },
    ]);
    await writeBenchmark(paths.benchmark, bench);

    const provider: HypothesisProvider = {
      async proposeHypothesis() {
        return null; // explicit no-op
      },
    };
    const runner: BenchmarkRunner = {
      async run() {
        return {
          passRate: 1.0,
          meanScore: 1.0,
          nRuns: 1,
          tasks: [{ id: "t1", pass: true }],
        };
      },
    };

    const evolve = new SelfEvolve({
      paths,
      currentRules: SAMPLE_RULES,
      hypothesisProvider: provider,
      benchmarkRunner: runner,
      shadowMode: false,
    });
    const result = await evolve.runOneCycle();
    expect(result.kept).toBe(false);
    expect(result.entry.hypothesis).toBe("no actionable hypothesis");
    expect(result.entry.status).toBe("reverted");
  });

  it("in shadow mode, never writes to the live ruleset", async () => {
    const paths = makePaths();
    const bench = makeBenchmark([
      { id: "t1", objective: "x", stubKind: "ok" },
    ]);
    await writeBenchmark(paths.benchmark, bench);

    // Pre-populate the live ruleset with a marker.
    await fs.mkdir(path.dirname(paths.ruleset), { recursive: true });
    await fs.writeFile(paths.ruleset, "INITIAL", "utf8");

    const provider: HypothesisProvider = {
      async proposeHypothesis() {
        return { text: "h", ruleChanges: SAMPLE_RULES };
      },
    };
    const runner: BenchmarkRunner = {
      async run() {
        return { passRate: 1.0, meanScore: 1.0, nRuns: 1, tasks: [{ id: "t1", pass: true }] };
      },
    };

    const evolve = new SelfEvolve({
      paths,
      currentRules: SAMPLE_RULES,
      hypothesisProvider: provider,
      benchmarkRunner: runner,
      shadowMode: true, // explicit shadow
    });
    await evolve.runOneCycle();
    // Live ruleset untouched.
    const live = await fs.readFile(paths.ruleset, "utf8");
    expect(live).toBe("INITIAL");
  });

  it("writes a snapshot before evaluating", async () => {
    const paths = makePaths();
    const bench = makeBenchmark([
      { id: "t1", objective: "x", stubKind: "ok" },
    ]);
    await writeBenchmark(paths.benchmark, bench);

    const provider: HypothesisProvider = {
      async proposeHypothesis() {
        return { text: "h", ruleChanges: SAMPLE_RULES };
      },
    };
    const runner: BenchmarkRunner = {
      async run() {
        return { passRate: 1.0, meanScore: 1.0, nRuns: 1, tasks: [{ id: "t1", pass: true }] };
      },
    };

    const evolve = new SelfEvolve({
      paths,
      currentRules: SAMPLE_RULES,
      hypothesisProvider: provider,
      benchmarkRunner: runner,
      shadowMode: true,
    });
    await evolve.runOneCycle();
    // The snapshot file should exist.
    const files = await fs.readdir(paths.snapshotDir);
    expect(files.some((f) => f.startsWith("v1."))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DefaultBenchmarkRunner
// ---------------------------------------------------------------------------

describe("DefaultBenchmarkRunner", () => {
  const runner = new DefaultBenchmarkRunner();

  it("passes an 'ok' stub that matches the objective", async () => {
    const bench = makeBenchmark([
      { id: "t1", objective: "deploy", stubKind: "ok" },
    ]);
    const result = await runner.run(SAMPLE_RULES, bench);
    expect(result.passRate).toBe(1.0);
  });

  it("fails an 'off-topic' stub", async () => {
    const bench = makeBenchmark([
      { id: "t1", objective: "deploy", stubKind: "off-topic" },
    ]);
    const result = await runner.run(SAMPLE_RULES, bench);
    expect(result.passRate).toBe(0.0);
  });

  it("fails an 'empty' stub", async () => {
    const bench = makeBenchmark([
      { id: "t1", objective: "deploy", stubKind: "empty" },
    ]);
    // non-empty-content rule fails on empty.
    const result = await runner.run(DEFAULT_RULES, bench);
    expect(result.passRate).toBe(0.0);
  });

  it("honors expectedVerdict for negative tests", async () => {
    const bench = makeBenchmark([
      // We want this case to pass iff the combined verdict is 'fail'.
      { id: "t1", objective: "deploy", stubKind: "ok", expectedVerdict: "fail" },
    ]);
    // 'ok' stub → combined verdict is 'pass', not 'fail' → pass=false.
    const result = await runner.run(SAMPLE_RULES, bench);
    expect(result.passRate).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// ModelHypothesisProvider — smoke test (no real model, just construction)
// ---------------------------------------------------------------------------

describe("ModelHypothesisProvider", () => {
  it("is constructible with a model adapter (smoke)", () => {
    // The class's `proposeHypothesis` calls the model; we just
    // verify the constructor doesn't throw. Real call would
    // require a model; the parser is already tested above.
    const fakeModel: import("../src/index.js").ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        return {
          content: [{ type: "text", text: "{}" }],
          stopReason: "end_turn",
        };
      },
    };
    const p = new ModelHypothesisProvider(fakeModel);
    expect(p).toBeInstanceOf(ModelHypothesisProvider);
  });
});
