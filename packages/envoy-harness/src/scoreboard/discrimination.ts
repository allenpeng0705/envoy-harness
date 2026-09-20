/**
 * Benchmark discrimination analysis.
 *
 * **Why this exists.** The self-evolution loop's action space is the set
 * of *subsets* (and orderings) of `DEFAULT_RULES`. A benchmark can only
 * drive that search if different subsets actually score differently. The
 * first frozen benchmark failed this: with the rules of the day, only
 * **3 distinct pass rates** existed across all 32 subsets, and the
 * best-scoring move was to *delete* a rule. The root cause was an inert
 * dimension — a rule that could be toggled without changing any outcome.
 *
 * This module makes that failure measurable before it is shipped:
 *
 * - **Unreachable task** — no legal subset passes it (a labelled column
 *   that is always wrong; it only dilutes the score). The old benchmark
 *   had one: `expectedVerdict: fail` at 1-in-3 overlap, because the
 *   overlap rule returned `partial` and every other subset passed.
 * - **Unrefutable task** — every legal subset passes it (contributes no
 *   discrimination).
 * - **Inert rule** — there is no pair of legal subsets differing only by
 *   this rule that score differently. Toggling it is free, so the loop
 *   can never learn anything about it.
 *
 * The gates themselves live in `test/benchmark-discrimination.test.ts`,
 * which CI runs on every push. This module only measures.
 */

import type { Benchmark, BenchmarkResult } from "./types.js";
import type { BenchmarkRunner } from "./self-evolve.js";
import type { VerifierRule } from "../verifier/index.js";

/** How often one benchmark task was passed, across the subset lattice. */
export interface TaskDiscrimination {
  id: string;
  /** Number of legal (non-empty) subsets whose run passes this task. */
  passedBy: number;
}

/** Whether toggling one rule ever changes a task outcome. */
export interface RuleDiscrimination {
  name: string;
  /**
   * True when some non-empty subset S (not containing the rule) scores
   * differently from S ∪ {rule}. False means the rule is an inert
   * dimension of the search space.
   */
  decisive: boolean;
}

/** The full report. */
export interface BenchmarkDiscrimination {
  ruleCount: number;
  /** Legal subsets examined: `2^ruleCount - 1` (the empty set is not a
   *  legal candidate — `parseHypothesisFromLlm` rejects it). */
  subsetCount: number;
  /** Distinct `passRate` values across those subsets. */
  distinctPassRates: number;
  /** Distinct per-task pass/fail vectors across those subsets. */
  distinctOutcomeVectors: number;
  passRateMin: number;
  passRateMax: number;
  perTask: ReadonlyArray<TaskDiscrimination>;
  perRule: ReadonlyArray<RuleDiscrimination>;
  /** Tasks no subset passes — always-wrong labels. */
  unreachableTasks: ReadonlyArray<string>;
  /** Tasks every subset passes — labels that discriminate nothing. */
  unrefutableTasks: ReadonlyArray<string>;
  /** Rules that can be added or dropped for free. */
  inertRules: ReadonlyArray<string>;
}

/** Encode a run's per-task outcome as a stable string key. */
function outcomeKey(result: BenchmarkResult): string {
  return result.tasks.map((t) => (t.pass ? "1" : "0")).join("");
}

/**
 * Run every legal rule subset against the benchmark and summarize how
 * much the score can move.
 *
 * The `runner` is injected (rather than imported) so this module stays
 * free of a runtime dependency on the protocol that uses it.
 */
export async function analyzeBenchmark(
  benchmark: Benchmark,
  rules: ReadonlyArray<VerifierRule>,
  runner: BenchmarkRunner,
): Promise<BenchmarkDiscrimination> {
  const n = rules.length;
  const subsetCount = n === 0 ? 0 : 2 ** n - 1;

  const passCounts = new Map<string, number>(benchmark.tasks.map((t) => [t.id, 0]));
  const distinctRateValues = new Set<number>();
  // Outcome vector per subset mask, so "decisive" can compare
  // S against S ∪ {rule} directly.
  const vectors = new Map<number, string>();
  let passRateMin = Number.POSITIVE_INFINITY;
  let passRateMax = Number.NEGATIVE_INFINITY;

  for (let mask = 1; mask <= subsetCount; mask++) {
    const subset: VerifierRule[] = [];
    for (let i = 0; i < n; i++) {
      const rule = rules[i];
      if ((mask & (1 << i)) !== 0 && rule !== undefined) subset.push(rule);
    }
    const result = await runner.run(subset, benchmark);
    const key = outcomeKey(result);
    vectors.set(mask, key);
    distinctRateValues.add(result.passRate);
    passRateMin = Math.min(passRateMin, result.passRate);
    passRateMax = Math.max(passRateMax, result.passRate);
    for (const task of result.tasks) {
      if (task.pass) {
        passCounts.set(task.id, (passCounts.get(task.id) ?? 0) + 1);
      }
    }
  }

  const perTask: TaskDiscrimination[] = benchmark.tasks.map((t) => ({
    id: t.id,
    passedBy: passCounts.get(t.id) ?? 0,
  }));

  const perRule: RuleDiscrimination[] = rules.map((rule, i) => {
    const bit = 1 << i;
    let decisive = false;
    for (let mask = 1; mask <= subsetCount && !decisive; mask++) {
      if ((mask & bit) === 0) continue;
      // Compare against the same subset with this rule removed. The
      // removed subset must itself be a legal (non-empty) candidate,
      // otherwise we would be measuring the empty ruleset, which the
      // loop is forbidden from proposing.
      const without = mask & ~bit;
      if (without === 0) continue;
      if (vectors.get(mask) !== vectors.get(without)) decisive = true;
    }
    return { name: rule.name, decisive };
  });

  return {
    ruleCount: n,
    subsetCount,
    distinctPassRates: distinctRateValues.size,
    distinctOutcomeVectors: new Set(vectors.values()).size,
    passRateMin: subsetCount === 0 ? 0 : passRateMin,
    passRateMax: subsetCount === 0 ? 0 : passRateMax,
    perTask,
    perRule,
    unreachableTasks: perTask.filter((t) => t.passedBy === 0).map((t) => t.id),
    unrefutableTasks:
      subsetCount === 0
        ? []
        : perTask.filter((t) => t.passedBy === subsetCount).map((t) => t.id),
    inertRules: perRule.filter((r) => !r.decisive).map((r) => r.name),
  };
}
