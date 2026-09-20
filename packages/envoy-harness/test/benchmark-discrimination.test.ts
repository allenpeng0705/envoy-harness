/**
 * The shared verifier benchmark must be able to drive the search.
 *
 * **What went wrong before.** The self-evolution loop's action space is
 * the set of subsets (and orderings) of `DEFAULT_RULES`. The first frozen
 * benchmark could not distinguish them: across all 32 subsets only **3
 * distinct pass rates** existed, and the best-scoring move was to *delete*
 * a rule. Two causes: an inert rule (toggling it changed nothing) and a
 * labelled task no subset could pass (`expectedVerdict: fail` at 1-in-3
 * keyword overlap, when the overlap rule returned `partial`).
 *
 * These tests are the CI gate that keeps that from shipping again. They
 * run on the same `pnpm test` CI already runs.
 */

import { describe, expect, it } from "vitest";

import {
  analyzeBenchmark,
  DEFAULT_RULES,
  DefaultBenchmarkRunner,
  readBenchmark,
  sharedBenchmarkPath,
  type Benchmark,
  type VerifierRule,
} from "../src/index.js";

async function loadCanonical(): Promise<Benchmark> {
  return readBenchmark(sharedBenchmarkPath());
}

describe("shared verifier benchmark (v1)", () => {
  it("labels every task, and never with a verdict no default rule emits", async () => {
    const bench = await loadCanonical();
    // Q6: ~15 tasks first; the labels are the uncertain part.
    expect(bench.tasks.length).toBeGreaterThanOrEqual(15);
    for (const task of bench.tasks) {
      // Q-settle: every task sets expectedVerdict. Omitting it silently
      // means "combined kind must be pass".
      expect(
        task.expectedVerdict,
        `task "${task.id}" must set expectedVerdict`,
      ).toBeDefined();
      // Q4 + settle: no `partial` or `disputed` labels in v1. No default
      // rule produces either, so such a task would be unreachable and
      // would only dilute the score.
      expect(
        ["pass", "fail"],
        `task "${task.id}" must be labelled pass or fail`,
      ).toContain(task.expectedVerdict);
    }
  });

  it("is non-degenerate: subsets do not collapse to one score", async () => {
    const bench = await loadCanonical();
    const report = await analyzeBenchmark(
      bench,
      DEFAULT_RULES,
      new DefaultBenchmarkRunner(),
    );
    // The empty ruleset is not a legal candidate (`parseHypothesisFromLlm`
    // rejects it), so the lattice is 2^n - 1.
    expect(report.subsetCount).toBe(2 ** DEFAULT_RULES.length - 1);
    // The old 4-task set produced 3 distinct pass rates over 32 subsets.
    // These floors are deliberately well below the current values so the
    // gate catches collapse, not ordinary editing.
    expect(report.distinctPassRates).toBeGreaterThanOrEqual(5);
    expect(report.distinctOutcomeVectors).toBeGreaterThanOrEqual(8);
    expect(report.passRateMax).toBeGreaterThan(report.passRateMin);
  });

  it("makes every default rule decisive on at least one task", async () => {
    const bench = await loadCanonical();
    const report = await analyzeBenchmark(
      bench,
      DEFAULT_RULES,
      new DefaultBenchmarkRunner(),
    );
    // An inert rule is a dimension the loop can toggle for free — the
    // exact defect that made the old benchmark degenerate.
    expect(report.inertRules).toEqual([]);
  });

  it("has no unreachable label", async () => {
    const bench = await loadCanonical();
    const report = await analyzeBenchmark(
      bench,
      DEFAULT_RULES,
      new DefaultBenchmarkRunner(),
    );
    // A task no legal subset passes is a permanently-wrong column: the
    // loop cannot learn from it.
    expect(report.unreachableTasks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sensitivity: the analyzer must actually detect the two degeneracies.
// A gate that cannot fail is not a gate.
// ---------------------------------------------------------------------------

function alwaysPass(name: string): VerifierRule {
  return {
    name,
    async check() {
      return { kind: "pass", score: 1.0, confidence: "high" };
    },
  };
}

function failsOnEmptyText(name: string): VerifierRule {
  return {
    name,
    async check(result) {
      const text = result.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      return text.length === 0
        ? { kind: "fail", reason: "empty output", rollback: false }
        : { kind: "pass", score: 1.0, confidence: "high" };
    },
  };
}

describe("analyzeBenchmark detects degeneracy", () => {
  it("flags two rules with identical behaviour as inert", async () => {
    const rules = [failsOnEmptyText("a"), failsOnEmptyText("b")];
    const bench: Benchmark = {
      name: "degenerate",
      tasks: [
        { id: "empty", objective: "x", stubKind: "empty", expectedVerdict: "fail" },
        { id: "ok", objective: "x", stubKind: "ok", expectedVerdict: "pass" },
      ],
    };
    const report = await analyzeBenchmark(bench, rules, new DefaultBenchmarkRunner());
    // Both rules are inert: a subset containing either behaves the same.
    expect(report.inertRules).toEqual(["a", "b"]);
    expect(report.distinctOutcomeVectors).toBe(1);
  });

  it("flags a label no subset can reach", async () => {
    const rules = [alwaysPass("ok-rule")];
    const bench: Benchmark = {
      name: "unreachable",
      tasks: [
        { id: "impossible", objective: "x", stubKind: "ok", expectedVerdict: "fail" },
      ],
    };
    const report = await analyzeBenchmark(bench, rules, new DefaultBenchmarkRunner());
    expect(report.unreachableTasks).toEqual(["impossible"]);
    expect(report.distinctPassRates).toBe(1);
  });
});
