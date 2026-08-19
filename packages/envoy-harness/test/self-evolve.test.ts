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
  loadRulesetFromFile,
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
  const KNOWN: ReadonlyArray<VerifierRule> = [
    {
      name: "x",
      description: "rule x",
      async check() {
        return { kind: "pass" as const, score: 1.0, confidence: "high" as const };
      },
    },
    {
      name: "a",
      description: "rule a",
      async check() {
        return { kind: "partial" as const, score: 0.5, reason: "a" };
      },
    },
  ];

  function makeResponse(text: string): ModelResponse {
    return {
      content: [{ type: "text", text }],
      stopReason: "end_turn",
    };
  }

  it("parses a well-formed JSON hypothesis", async () => {
    const r = parseHypothesisFromLlm(
      makeResponse(JSON.stringify({
        text: "Add a stricter check",
        ruleChanges: [{ name: "x", description: "y" }],
      })),
      KNOWN,
    );
    expect(r?.text).toBe("Add a stricter check");
    expect(r?.ruleChanges).toHaveLength(1);
    expect(r?.ruleChanges[0]?.name).toBe("x");
    // The check implementation is inherited from the current ruleset
    // (rule bodies are code, not model output).
    expect(await r?.ruleChanges[0]?.check({} as never, "")).toEqual({
      kind: "pass",
      score: 1.0,
      confidence: "high",
    });
  });

  it("extracts JSON from surrounding prose", () => {
    const r = parseHypothesisFromLlm(
      makeResponse(`Here is my proposal: ${JSON.stringify({ text: "x", ruleChanges: [{ name: "a", description: "b" }] })} -- end`),
      KNOWN,
    );
    expect(r?.text).toBe("x");
    expect(r?.ruleChanges[0]?.name).toBe("a");
  });

  it("returns null on empty ruleChanges (no-op)", () => {
    const r = parseHypothesisFromLlm(
      makeResponse(JSON.stringify({ text: "no actionable", ruleChanges: [] })),
      KNOWN,
    );
    expect(r).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseHypothesisFromLlm(makeResponse("not json"), KNOWN)).toBeNull();
  });

  it("returns null when text is missing", () => {
    expect(
      parseHypothesisFromLlm(
        makeResponse(JSON.stringify({ ruleChanges: [{ name: "x", description: "y" }] })),
        KNOWN,
      ),
    ).toBeNull();
  });

  it("returns null when ruleChanges is not an array", () => {
    expect(
      parseHypothesisFromLlm(
        makeResponse(JSON.stringify({ text: "x", ruleChanges: "not-an-array" })),
        KNOWN,
      ),
    ).toBeNull();
  });

  it("rejects rule names that are not in the current ruleset", () => {
    const r = parseHypothesisFromLlm(
      makeResponse(
        JSON.stringify({ text: "x", ruleChanges: [{ name: "invented" }] }),
      ),
      KNOWN,
    );
    expect(r).toBeNull();
  });

  it("accepts a subset of the current ruleset", () => {
    const r = parseHypothesisFromLlm(
      makeResponse(JSON.stringify({ text: "keep only x", ruleChanges: [{ name: "x" }] })),
      KNOWN,
    );
    expect(r?.ruleChanges.map((rule) => rule.name)).toEqual(["x"]);
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
// loadRulesetFromFile
// ---------------------------------------------------------------------------

describe("loadRulesetFromFile", () => {
  it("resolves committed rule names back to real rules", async () => {
    const file = path.join(tmpDir, "ruleset.json");
    await fs.writeFile(
      file,
      JSON.stringify([{ name: "non-empty-content" }, { name: "mesh-task-shape" }]),
      "utf8",
    );
    const loaded = await loadRulesetFromFile(file, DEFAULT_RULES);
    expect(loaded?.map((r) => r.name)).toEqual([
      "non-empty-content",
      "mesh-task-shape",
    ]);
    // The check functions are the real ones, not placeholders.
    expect(await loaded?.[0]?.check({ content: [] } as never, "")).toMatchObject({
      kind: "fail",
    });
  });

  it("returns null when the file is missing", async () => {
    expect(
      await loadRulesetFromFile(path.join(tmpDir, "missing.json"), DEFAULT_RULES),
    ).toBeNull();
  });

  it("returns null when a name is unknown to the code ruleset", async () => {
    const file = path.join(tmpDir, "ruleset.json");
    await fs.writeFile(
      file,
      JSON.stringify([{ name: "invented-rule" }]),
      "utf8",
    );
    expect(await loadRulesetFromFile(file, DEFAULT_RULES)).toBeNull();
  });

  // T1.3: the file format is now versioned. v1 is
  // an object with formatVersion + rules; v0 is the
  // bare array (legacy). Other formatVersion values
  // are rejected with a clear error.

  it("accepts a v1 file (object with formatVersion + rules)", async () => {
    const file = path.join(tmpDir, "ruleset-v1.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        formatVersion: 1,
        rules: [{ name: "non-empty-content" }, { name: "mesh-task-shape" }],
      }),
      "utf8",
    );
    const loaded = await loadRulesetFromFile(file, DEFAULT_RULES);
    expect(loaded?.map((r) => r.name)).toEqual([
      "non-empty-content",
      "mesh-task-shape",
    ]);
  });

  it("accepts a v0 file (bare array) for backward compat", async () => {
    const file = path.join(tmpDir, "ruleset-v0.json");
    await fs.writeFile(
      file,
      JSON.stringify([{ name: "non-empty-content" }]),
      "utf8",
    );
    const loaded = await loadRulesetFromFile(file, DEFAULT_RULES);
    expect(loaded?.map((r) => r.name)).toEqual(["non-empty-content"]);
  });

  it("rejects an unknown future formatVersion with a clear error", async () => {
    const file = path.join(tmpDir, "ruleset-future.json");
    await fs.writeFile(
      file,
      JSON.stringify({ formatVersion: 999, rules: [] }),
      "utf8",
    );
    await expect(loadRulesetFromFile(file, DEFAULT_RULES)).rejects.toThrow(
      /unsupported formatVersion 999/,
    );
  });

  it("returns null for a v1 file with a non-array rules field", async () => {
    const file = path.join(tmpDir, "ruleset-bad-v1.json");
    await fs.writeFile(
      file,
      JSON.stringify({ formatVersion: 1, rules: "not-an-array" }),
      "utf8",
    );
    expect(await loadRulesetFromFile(file, DEFAULT_RULES)).toBeNull();
  });

  it("returns null for a malformed shape (neither array nor object)", async () => {
    const file = path.join(tmpDir, "ruleset-bad-shape.json");
    await fs.writeFile(file, JSON.stringify("a-string"), "utf8");
    expect(await loadRulesetFromFile(file, DEFAULT_RULES)).toBeNull();
  });

  it("end-to-end: a committed v1 file is loadable + the ruleset's `check` impls are the real ones", async () => {
    // The end-to-end "the cycle uses the loaded ruleset"
    // is wired in src/cli/run.ts:561 (committed → currentRules).
    // Here we just verify the loader's contract: a v1
    // file with one rule resolves to a 1-rule array
    // where the rule's `check` is the real impl
    // (not a placeholder). The cycle would just
    // call those checks via runVerifierRules.
    const rulesetFile = path.join(tmpDir, "ruleset.json");
    await fs.writeFile(
      rulesetFile,
      JSON.stringify({
        formatVersion: 1,
        rules: [{ name: "non-empty-content" }, { name: "mesh-task-shape" }],
      }),
      "utf8",
    );
    const loaded = await loadRulesetFromFile(rulesetFile, DEFAULT_RULES);
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(2);
    // The check impls are the real ones (not stubs).
    // We can call them directly to prove they're real.
    expect(loaded![0]!.name).toBe("non-empty-content");
    const verdict = await loaded![0]!.check(
      { content: [{ type: "text", text: "x" }] } as never,
      "test",
    );
    expect(verdict).not.toBeNull();
    expect(verdict!.kind).toBe("pass");
  });

  it("runOneCycle throws when the frozen benchmark is missing", async () => {
    const paths = makePaths();
    const evolve = new SelfEvolve({
      paths,
      currentRules: SAMPLE_RULES,
      hypothesisProvider: {
        async proposeHypothesis(): Promise<Hypothesis> {
          return { text: "x", ruleChanges: [] };
        },
      },
      benchmarkRunner: {
        async run() {
          return { passRate: 0, meanScore: 0, nRuns: 0, tasks: [] };
        },
      },
    });
    // The benchmark path doesn't exist; a missing benchmark is an
    // operator error, not a silent empty run.
    await expect(evolve.runOneCycle()).rejects.toThrow(/ENOENT/);
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
