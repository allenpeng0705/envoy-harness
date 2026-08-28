/**
 * Tests for `src/plan/inject.ts` — the plan fragment
 * builder.
 *
 * Covers:
 * 1. Returns `[]` for `undefined` / inactive / non-
 *    approved plans.
 * 2. Returns a single fragment when the plan is
 *    active + approved.
 * 3. The fragment has `priority: 1000` (the highest).
 * 4. The fragment's `render()` is stable + parseable.
 */

import { describe, expect, it } from "vitest";

import {
  PLAN_FRAGMENT_PRIORITY,
  buildPlanFragment,
  renderPlanText,
} from "../../src/plan/inject.js";
import { createPlanState, applyTransition } from "../../src/plan/state.js";

describe("buildPlanFragment", () => {
  it("returns [] for undefined plan", () => {
    expect(buildPlanFragment(undefined)).toEqual([]);
  });

  it("returns [] for an inactive plan", () => {
    const s = createPlanState();
    expect(buildPlanFragment(s)).toEqual([]);
  });

  it("returns [] for a draft plan (not approved)", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    s = applyTransition(s, { kind: "edit", planText: "p" });
    expect(buildPlanFragment(s)).toEqual([]);
  });

  it("returns [] for a proposed plan (not approved)", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    s = applyTransition(s, { kind: "edit", planText: "p" });
    s = applyTransition(s, { kind: "propose" });
    expect(buildPlanFragment(s)).toEqual([]);
  });

  it("returns [] for a rejected plan (not approved)", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    s = applyTransition(s, { kind: "reject" });
    expect(buildPlanFragment(s)).toEqual([]);
  });

  it("returns [] for an approved plan with empty text", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    s = applyTransition(s, { kind: "propose" });
    s = applyTransition(s, { kind: "approve" });
    expect(buildPlanFragment(s)).toEqual([]);
  });

  it("returns a single fragment for an active + approved plan with text", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    s = applyTransition(s, { kind: "edit", planText: "step 1: do X" });
    s = applyTransition(s, { kind: "propose" });
    s = applyTransition(s, { kind: "approve" });
    const fragments = buildPlanFragment(s);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.id).toBe("plan");
    expect(fragments[0]!.owner).toBe("plan");
    expect(fragments[0]!.priority).toBe(PLAN_FRAGMENT_PRIORITY);
    expect(fragments[0]!.priority).toBe(1000);
    expect(fragments[0]!.estimatedTokens).toBeGreaterThan(0);
  });
});

describe("renderPlanText", () => {
  it("includes the updatedAt timestamp + plan text", () => {
    const clock = () => "2026-08-21T00:00:00Z";
    let s = createPlanState(clock);
    s = applyTransition(s, { kind: "enter" }, clock);
    s = applyTransition(s, { kind: "edit", planText: "do X then Y" }, clock);
    const text = renderPlanText(s);
    expect(text).toContain("2026-08-21T00:00:00Z");
    expect(text).toContain("do X then Y");
    expect(text).toMatch(/^ACTIVE PLAN/);
  });
});
