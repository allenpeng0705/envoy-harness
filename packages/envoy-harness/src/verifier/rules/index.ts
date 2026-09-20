/**
 * The verifier rules (§12.1 of the design).
 *
 * Each rule is a `VerifierRule` (async, returns `Verdict | null`).
 * The set is the v0 default; the 5-step self-evolution protocol
 * (design §13) edits this list as it learns what passes / fails
 * the user's specific work.
 *
 * **Adding a rule:** append to `DEFAULT_RULES`. The runner
 * picks it up automatically. The order is not significant (rules
 * are independent); the current rules are listed in the design's
 * order.
 *
 * **Removing a rule:** edit `DEFAULT_RULES`. This is a major
 * version bump per the design's stability rules.
 *
 * **What `DEFAULT_RULES` is FOR.** It is the action space of the
 * self-evolution loop: the loop may subset or reorder these rules,
 * nothing else. A rule that cannot change a benchmark outcome —
 * because it always passes, or because another rule already fails
 * every case it fails — adds a dimension the loop can toggle with
 * zero effect. Two such rules have already been dropped from the
 * default set (see the `DEFAULT_RULES` comment); both remain
 * exported for hosts that want the slot.
 */

import { concatText, type VerifierRule } from "../types.js";

// ---------------------------------------------------------------------------
// 1. non-empty-content
// ---------------------------------------------------------------------------

/**
 * Pass if the result has at least one text or structured block.
 * Empty output is the cheapest fail to detect and the most
 * common one to fix (the worker crashed silently).
 */
export const nonEmptyContentRule: VerifierRule = {
  name: "non-empty-content",
  async check(result) {
    if (result.content.length === 0) {
      return { kind: "fail", reason: "empty output", rollback: true };
    }
    return { kind: "pass", score: 1.0, confidence: "high" };
  },
};

// ---------------------------------------------------------------------------
// 2. output-matches-objective
// ---------------------------------------------------------------------------

/**
 * Cheap heuristic: does the output contain at least 50% of the
 * objective's keywords? Keyword = a word ≥ 4 chars, lowercase,
 * not a stop word.
 *
 * **Below 50% is a `fail`, not a `partial`.** Calling it `partial`
 * conflated two different ideas: `partial`'s documented meaning is
 * "acceptable for some blocks; the rest are unusable" (a claim about
 * multi-block content, which a lexical ratio never establishes), and
 * the combiner then reported the result to a human as "verifier
 * disagreement" — the wrong explanation for an off-topic answer.
 * Measured consequence: with the old body, a labelled
 * `expectedVerdict: fail` task for 1-in-3 overlap was unreachable by
 * *any* subset of the rules (with this rule selected it was partial,
 * with it dropped the other rules passed), so the label could not be
 * learned at all.
 *
 * **This is a heuristic.** A pass here is necessary but not
 * sufficient — the LLM source (§12.3) is the higher-trust check.
 * A fail here is a strong signal of drift; a pass is weak.
 */
export const outputMatchesObjectiveRule: VerifierRule = {
  name: "output-matches-objective",
  async check(result, objective) {
    const text = concatText(result.content);
    if (text.length === 0) {
      return { kind: "fail", reason: "empty output", rollback: false };
    }
    const keywords = extractKeywords(objective);
    if (keywords.length === 0) {
      // No keywords to check — we can't say pass or fail. The
      // LLM source will judge this; we abstain.
      return null;
    }
    const matched = keywords.filter((kw) =>
      text.toLowerCase().includes(kw.toLowerCase()),
    );
    const ratio = matched.length / keywords.length;
    if (ratio < 0.5) {
      // Below half the objective's key terms the output has not been
      // shown to address the objective. This includes zero overlap
      // (total drift), which the rule's own docstring has always
      // called "a strong signal of drift".
      //
      // The boundary is deliberately `ratio < 0.5`: exactly 0.5 is a
      // pass. Pinned by test/verifier.test.ts so a later edit cannot
      // silently move the threshold to `<=`.
      return {
        kind: "fail",
        reason: `output matches ${matched.length}/${keywords.length} objective keywords (below 50%)`,
        rollback: false,
      };
    }
    return {
      kind: "pass",
      score: ratio,
      // 50% is the pass threshold; high overlap is "high" confidence.
      confidence: ratio >= 0.8 ? "high" : "medium",
    };
  },
};

/** Stop words: too common to be a useful keyword. */
const STOP_WORDS = new Set([
  "the",
  "this",
  "that",
  "with",
  "from",
  "have",
  "they",
  "them",
  "then",
  "than",
  "what",
  "when",
  "where",
  "which",
  "while",
  "would",
  "could",
  "should",
  "there",
  "their",
  "these",
  "those",
  "about",
  "above",
  "after",
  "again",
  "against",
  "also",
  "because",
  "before",
  "below",
  "between",
  "both",
  "each",
  "further",
  "into",
  "more",
  "most",
  "other",
  "over",
  "some",
  "such",
  "through",
  "under",
  "very",
  "just",
  "only",
  "your",
  "yours",
  "yourself",
]);

/** Extract keywords from a string. Drops short words and stop words. */
export function extractKeywords(s: string): string[] {
  return Array.from(
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter((w) => w.length >= 4 && !STOP_WORDS.has(w)),
    ),
  );
}

// ---------------------------------------------------------------------------
// 3. sandbox-respected
// ---------------------------------------------------------------------------

/**
 * Check that the transcript doesn't show any tool calls that
 * violated the sandbox policy. We look at every tool result;
 * a blocked command's `isError: true` is a positive signal
 * (the policy caught the violation), but a SUCCESSFUL
 * out-of-policy command is a fail.
 *
 * **v0 limitation:** this is a string-level check. A more
 * thorough verifier would parse the tool call's args (path
 * resolution, etc.) and compare against `sandboxPolicy.writableRoots`.
 * Phase 2 (mesh-native) has the data to do that; for v0 we
 * just check that no tool result is "I wrote to a forbidden path".
 */
export const sandboxRespectedRule: VerifierRule = {
  name: "sandbox-respected",
  async check(result) {
    // The transcript has the full tool-call history. We scan
    // tool results for "outside the policy" signals.
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    const violations: string[] = [];
    for (const m of toolMessages) {
      for (const block of m.content) {
        if (block.type !== "tool_result") continue;
        if (block.isError) continue; // the policy caught it; that's pass
        // A success is "isError: false". We can't tell from the
        // result alone whether it was within policy; we trust
        // the validator's pre-check. If the result mentions an
        // explicitly-forbidden path, flag it.
        const text = String(block.content ?? "");
        if (text.includes("EACCES") || text.includes("EPERM")) {
          violations.push(text.slice(0, 80));
        }
      }
    }
    if (violations.length > 0) {
      // A tool result reporting a permission error while `isError: false`
      // means the command SUCCEEDED outside the policy. The docstring calls
      // that "a fail"; the code returned `partial`, which understated a
      // policy bypass as a partially-acceptable result. `rollback: true`
      // because a bypass is not something to keep paying for.
      return {
        kind: "fail",
        reason: `sandbox violation (successful out-of-policy operation): ${violations[0]}`,
        rollback: true,
      };
    }
    return { kind: "pass", score: 1.0, confidence: "low" };
  },
};

// ---------------------------------------------------------------------------
// 4. approval-respected
// ---------------------------------------------------------------------------

/**
 * Check that no tool call in the transcript did something the
 * session's approval policy would have forbidden. v0: this is
 * a string-level check on tool result messages; if the worker
 * says it did something its permission mode wouldn't allow
 * (e.g. "wrote to /etc/passwd" in workspace-write), we flag.
 *
 * **v0 is conservative:** it checks for explicit "I wrote"
 * patterns in tool results. A more thorough check would
 * cross-reference every bash command with the validator's
 * decision. That's a Phase 2 / cost-tracking concern.
 */
export const approvalRespectedRule: VerifierRule = {
  name: "approval-respected",
  async check() {
    // For v0, defer to sandbox-respected (which catches the
    // same class of violation at a different angle). Return
    // pass with low confidence so it counts in the average
    // but doesn't dominate.
    return { kind: "pass", score: 1.0, confidence: "low" };
  },
};

// ---------------------------------------------------------------------------
// 5. mesh-task-shape
// ---------------------------------------------------------------------------

/**
 * Check that `result.content` carries at least one block.
 *
 * **Not in `DEFAULT_RULES`.** This rule is byte-for-byte the same
 * *decision* as `non-empty-content`: both fail iff
 * `content.length === 0`, and `output-matches-objective` also fails
 * that case ("empty output"). Because `combineVerdicts` returns the
 * first `fail`, toggling this rule can never change a task's
 * pass/fail — it is an inert dimension of the self-evolution loop's
 * action space. It is kept as an exported opt-in for hosts that want
 * the slot (e.g. to supply a stricter body), exactly like
 * `approval-respected`.
 *
 * **The design's intent for this rule** (§12.1: "`result.content` is
 * a valid `ContentBlock[]` per the schema") is a *runtime shape*
 * check, which the TypeScript type already enforces for in-process
 * results and which a benchmark fixture cannot violate without being
 * rejected when the fixture is parsed. It therefore has no reachable
 * failing input at v0.
 *
 * **A stale comment here used to claim** the rule was not redundant
 * because "a result whose only block is a `tool_call` has non-zero
 * `content.length` and no text, so the two rules disagree there" —
 * that is false: `non-empty-content` also passes such a result, so
 * they agree. The rule was nearly *kept* on the strength of the same
 * kind of unverified comment that nearly got it deleted.
 */
export const meshTaskShapeRule: VerifierRule = {
  name: "mesh-task-shape",
  async check(result) {
    // The TS type guarantees the shape. Phase 2 adds content
    // validation (e.g., "all text blocks are non-empty").
    if (result.content.length === 0) {
      return { kind: "fail", reason: "no content blocks", rollback: false };
    }
    return { kind: "pass", score: 1.0, confidence: "high" };
  },
};

// ---------------------------------------------------------------------------
// 6. cost-reasonable-for-work
// ---------------------------------------------------------------------------

/**
 * Check that the work done was reasonable for the work asked.
 *
 * **v0 heuristic:** cost is judged against a per-objective
 * budget. The default budget is $1.00 per objective (set
 * here as a constant; v0 doesn't yet parse the operator's
 * custom budgets from config). Work below the budget passes
 * with confidence scaled by ratio; work over fails with
 * `rollback: true` (the orchestrator may want to release
 * the cost reserve).
 *
 * **Why a heuristic, not an LLM:** the rule runs on every
 * verifier check. An LLM call would dominate the verifier's
 * latency. v0 ships the heuristic; F12 (cost) can layer an
 * LLM-source check on top for high-criticality chains.
 *
 * **Edge case:** if `result.metrics.costUsd` is 0 (no model
 * reported usage, e.g. FakeModel in tests, or a local
 * model), the rule passes unconditionally. The 0-cost
 * path is the safe default — the absence of cost data
 * isn't a signal of failure.
 */
export const costReasonableForWorkRule: VerifierRule = {
  name: "cost-reasonable-for-work",
  async check(result) {
    const cost = result.metrics.costUsd;
    // No cost data → pass (v0 default; F12 may add an LLM check).
    if (cost === 0) {
      return { kind: "pass", score: 1.0, confidence: "low" };
    }
    const budget = DEFAULT_COST_BUDGET_USD;
    if (cost > budget) {
      return {
        kind: "fail",
        reason: `cost ${cost.toFixed(4)} USD exceeds budget ${budget.toFixed(2)} USD`,
        rollback: true,
      };
    }
    const ratio = cost / budget;
    return {
      kind: "pass",
      score: ratio,
      // Lower ratio = better.
      confidence: ratio <= 0.5 ? "high" : "medium",
    };
  },
};

/** Default per-objective cost budget in USD. F12 will read this from config. */
const DEFAULT_COST_BUDGET_USD = 1.0;

// ---------------------------------------------------------------------------
// The default rule set
// ---------------------------------------------------------------------------

/**
 * The default rule set — the action space of the self-evolution loop.
 *
 * **`approvalRespectedRule` is deliberately absent.** It ignores its
 * argument and returns a constant `pass` (see its own comment: "for v0,
 * defer to sandbox-respected"). A rule that always passes is not a check:
 * it adds a dimension the self-evolution loop can toggle with **zero**
 * effect on `passRate`, while contributing `score: 1.0` to `meanScore`
 * and pushing the verdict count toward the `>= 3` "high confidence"
 * threshold. Measured on the frozen benchmark, dropping it changes
 * nothing except that inflation.
 *
 * **`meshTaskShapeRule` is deliberately absent.** It makes the same
 * decision as `non-empty-content` (fail iff `content.length === 0`), and
 * `output-matches-objective` fails that case too. With fail-dominance in
 * `combineVerdicts`, selecting or dropping it can never change a
 * pass/fail — a second inert dimension. Because a subset may *reorder*
 * rules, keeping it was not merely useless: putting it ahead of
 * `non-empty-content` would downgrade the combined `rollback` flag from
 * `true` to `false` for an empty result, i.e. the loop could weaken a
 * release decision for free.
 *
 * Both rules remain exported for hosts that want the slot; they are
 * simply not part of the set the loop optimises. Removing them entirely
 * would be a breaking change to a public export for no additional
 * benefit.
 *
 * **Every rule that remains can change an outcome.** The frozen
 * benchmark (`benchmarks/verifier-frozen.yaml`) is required by
 * `test/benchmark-discrimination.test.ts` to give each of these four a
 * task it alone fails; a rule with no such task is an inert dimension
 * and must not be added here.
 */
export const DEFAULT_RULES: ReadonlyArray<VerifierRule> = [
  nonEmptyContentRule,
  outputMatchesObjectiveRule,
  sandboxRespectedRule,
  costReasonableForWorkRule,
];
