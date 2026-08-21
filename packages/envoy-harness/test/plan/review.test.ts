/**
 * Tests for `src/plan/review.ts` — the verifier
 * handoff.
 *
 * Covers:
 * 1. No plan → `fail` verdict with a "use /plan
 *    first" suggestion.
 * 2. A plan + result that passes → `pass` verdict
 *    (the default rules don't flag the result).
 * 3. A plan + result with a "EACCES" string in it →
 *    `partial` (the sandbox-respected rule flags it).
 * 4. A custom rule → the verdict reflects the rule's
 *    output.
 *
 * **Hermetic:** the default rules are pure; the
 * tests use real `DEFAULT_RULES` + a fake rule.
 */

import { describe, expect, it } from "vitest";

import { runReview } from "../../src/plan/review.js";
import {
  createPlanState,
  applyTransition,
} from "../../src/plan/state.js";
import type { VerifierRule } from "../../src/verifier/index.js";
import type { Verdict } from "../../src/types.js";

async function makeApprovedPlan(text: string) {
  let s = createPlanState();
  s = applyTransition(s, { kind: "enter" });
  s = applyTransition(s, { kind: "edit", planText: text });
  s = applyTransition(s, { kind: "propose" });
  s = applyTransition(s, { kind: "approve" });
  return s;
}

describe("runReview", () => {
  it("returns a fail verdict with 'use /plan first' when no plan", async () => {
    const r = await runReview(undefined, "the result");
    expect(r.verdict.kind).toBe("fail");
    expect(r.suggestion).toMatch(/\/plan/);
  });

  it("returns a fail when the plan has no text", async () => {
    const plan = await makeApprovedPlan("");
    // After approve the text is "". The review
    // should fail with "no plan to review".
    // Wait — makeApprovedPlan sets text to "" → that
    // hits the "no plan to review" branch (which
    // also checks empty text).
    const r = await runReview(plan, "result");
    expect(r.verdict.kind).toBe("fail");
  });

  it("returns a pass verdict for a clean result against a clean plan", async () => {
    const plan = await makeApprovedPlan("step 1: do X");
    const r = await runReview(plan, "the result of step 1");
    // The default rules don't fail on clean input;
    // combineVerdicts returns pass when all rules
    // pass.
    expect(r.verdict.kind).toBe("pass");
    expect(r.summary).toMatch(/^pass/);
  });

  it("returns a partial verdict when the result contains 'EACCES'", async () => {
    const plan = await makeApprovedPlan("step 1: do X");
    const r = await runReview(plan, "Error: EACCES opening file");
    // The sandbox-respected rule returns partial
    // when it sees EACCES.
    expect(r.verdict.kind).toBe("partial");
  });

  it("honors a custom ruleset (a passing fake rule)", async () => {
    const plan = await makeApprovedPlan("step 1: do X");
    const pass: VerifierRule = {
      name: "always-pass",
      async check() {
        const v: Verdict = {
          kind: "pass",
          score: 1,
          confidence: "high",
        };
        return v;
      },
    };
    const r = await runReview(plan, "result", { rules: [pass] });
    expect(r.verdict.kind).toBe("pass");
  });

  it("honors a custom ruleset (a failing fake rule)", async () => {
    const plan = await makeApprovedPlan("step 1: do X");
    const fail: VerifierRule = {
      name: "always-fail",
      async check() {
        const v: Verdict = {
          kind: "fail",
          reason: "test fail",
          rollback: false,
        };
        return v;
      },
    };
    const r = await runReview(plan, "result", { rules: [fail] });
    expect(r.verdict.kind).toBe("fail");
  });
});
