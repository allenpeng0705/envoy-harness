/**
 * SelfEvolve e2e tests (Phase 3, 5c + 5d).
 *
 * Combines the frozen benchmark fixture (5c) with a full
 * shadow cycle (5d). The contamination guard is verified
 * end-to-end: a benchmark containing known "gold" strings
 * never appears in the hypothesis prompt.
 *
 * **Test isolation:** every test uses a fresh temp dir;
 * the fixture file is read-only and shared across tests.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildHypothesisPrompt,
  readScoreboard,
  SelfEvolve,
  writeBenchmark,
  type Hypothesis,
  type HypothesisProvider,
  type SelfEvolvePaths,
  type VerifierRule,
} from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FROZEN_BENCHMARK = path.join(HERE, "fixtures", "frozen-benchmark.yaml");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-harness-se-e2e-"));
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

const SAMPLE_RULES: VerifierRule[] = [
  {
    name: "non-empty",
    description: "result must not be empty",
    async check() {
      return { kind: "pass" as const, score: 1.0, confidence: "high" as const };
    },
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
// 5c: frozen benchmark fixture
// ---------------------------------------------------------------------------

describe("frozen benchmark fixture", () => {
  it("loads and round-trips through SelfEvolve", async () => {
    // Copy the fixture into the test's tmpDir so the cycle
    // can read it as if it were a real benchmark.
    const paths = makePaths();
    const fixtureContent = await fs.readFile(FROZEN_BENCHMARK, "utf8");
    await fs.writeFile(paths.benchmark, fixtureContent, "utf8");
    // Verify the shape.
    const { readBenchmark } = await import("../src/index.js");
    const bench = await readBenchmark(paths.benchmark);
    expect(bench.name).toBe("envoy-harness-smoke");
    expect(bench.tasks.length).toBeGreaterThanOrEqual(4);
    const ids = bench.tasks.map((t) => t.id);
    expect(ids).toContain("smoke-deploy");
    expect(ids).toContain("smoke-off-topic");
    expect(ids).toContain("smoke-empty");
    expect(ids).toContain("smoke-forbidden");
  });
});

// ---------------------------------------------------------------------------
// 5d: full shadow cycle e2e
// ---------------------------------------------------------------------------

describe("SelfEvolve full shadow cycle e2e", () => {
  it("runs a complete shadow cycle against the frozen benchmark", async () => {
    // Copy the fixture into the test's tmpDir.
    const paths = makePaths();
    await fs.copyFile(FROZEN_BENCHMARK, paths.benchmark);
    // Pre-populate the live ruleset with a marker.
    await fs.mkdir(path.dirname(paths.ruleset), { recursive: true });
    await fs.writeFile(paths.ruleset, "INITIAL-RULES", "utf8");

    // The hypothesis provider always proposes a hypothetical
    // improvement; the runner reports it as a strict improvement.
    const provider: HypothesisProvider = {
      async proposeHypothesis(): Promise<Hypothesis> {
        return {
          text: "stricter off-topic detection",
          ruleChanges: SAMPLE_RULES,
        };
      },
    };
    let callCount = 0;
    const runner = {
      async run() {
        callCount++;
        // Baseline (current rules) scores 0.5; candidate scores 1.0.
        const isCandidate = callCount === 2;
        return {
          passRate: isCandidate ? 1.0 : 0.5,
          meanScore: isCandidate ? 1.0 : 0.5,
          nRuns: 4,
          tasks: [
            { id: "smoke-deploy", pass: isCandidate },
            { id: "smoke-off-topic", pass: isCandidate },
            { id: "smoke-empty", pass: isCandidate },
            { id: "smoke-forbidden", pass: isCandidate },
          ],
        };
      },
    };

    const evolve = new SelfEvolve({
      paths,
      currentRules: SAMPLE_RULES,
      hypothesisProvider: provider,
      benchmarkRunner: runner,
      shadowMode: true, // explicit
    });
    const result = await evolve.runOneCycle();

    // The cycle ran in shadow mode: the live ruleset was NOT
    // touched, but a kept entry was recorded.
    const live = await fs.readFile(paths.ruleset, "utf8");
    expect(live).toBe("INITIAL-RULES");
    expect(result.kept).toBe(true);
    expect(result.entry.status).toBe("kept");
    // The scoreboard has exactly one entry.
    const board = await readScoreboard(paths.scoreboard);
    expect(board).toHaveLength(1);
    expect(board[0]?.version).toBe(1);
    expect(board[0]?.hypothesis).toBe("stricter off-topic detection");
    // A snapshot was written.
    const files = await fs.readdir(paths.snapshotDir);
    expect(files.some((f) => f.startsWith("v1."))).toBe(true);
    // The candidate ruleset was also written.
    expect(files.some((f) => f === "v1.candidate.json")).toBe(true);
  });

  it("the contamination guard holds end-to-end: the prompt never contains benchmark text", async () => {
    // Build a benchmark with UNIQUE strings that should NEVER
    // appear in the hypothesis prompt. The provider captures
    // the prompt it was given; the test asserts the captured
    // prompt does NOT contain any of the unique strings.
    const SECRET_PHRASE = "ANTIMATTER_KEYWORD_xK3p9QwL";
    const paths = makePaths();
    const bench = {
      name: "contaminated",
      tasks: [
        {
          id: "t1",
          objective: `do something with ${SECRET_PHRASE}`,
          stubKind: "ok" as const,
        },
      ],
    };
    await writeBenchmark(paths.benchmark, bench);

    let capturedPrompt: string | undefined;
    const provider: HypothesisProvider = {
      async proposeHypothesis(input) {
        // The provider's prompt is built from the safe inputs.
        // We don't have direct access to the model's input, so
        // we re-build the prompt the same way the
        // ModelHypothesisProvider would, and verify.
        capturedPrompt = buildHypothesisPrompt(input);
        return null; // no-op
      },
    };
    const runner = {
      async run() {
        return { passRate: 0, meanScore: 0, nRuns: 1, tasks: [{ id: "t1", pass: false }] };
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

    // The captured prompt was built from the safe inputs only.
    // The benchmark's secret phrase MUST NOT appear in it.
    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt).not.toContain(SECRET_PHRASE);
    expect(capturedPrompt).not.toMatch(/benchmark/i);
    expect(capturedPrompt).not.toMatch(/gold/i);
    expect(capturedPrompt).not.toMatch(/rubric/i);
  });

  it("reverts when the candidate is no better than the baseline", async () => {
    const paths = makePaths();
    await fs.copyFile(FROZEN_BENCHMARK, paths.benchmark);

    const provider: HypothesisProvider = {
      async proposeHypothesis() {
        return { text: "no improvement", ruleChanges: SAMPLE_RULES };
      },
    };
    // Both baseline and candidate score 1.0. Strictly greater
    // is false → revert.
    const runner = {
      async run() {
        return {
          passRate: 1.0,
          meanScore: 1.0,
          nRuns: 4,
          tasks: [
            { id: "smoke-deploy", pass: true },
            { id: "smoke-off-topic", pass: true },
            { id: "smoke-empty", pass: true },
            { id: "smoke-forbidden", pass: true },
          ],
        };
      },
    };
    const evolve = new SelfEvolve({
      paths,
      currentRules: SAMPLE_RULES,
      hypothesisProvider: provider,
      benchmarkRunner: runner,
      shadowMode: true,
    });
    const result = await evolve.runOneCycle();
    expect(result.kept).toBe(false);
    expect(result.entry.status).toBe("reverted");

    const board = await readScoreboard(paths.scoreboard);
    expect(board[0]?.status).toBe("reverted");
  });
});
