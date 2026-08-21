/**
 * Tests for `src/plan/state.ts` — the plan state
 * lifecycle.
 *
 * Covers:
 * 1. `createPlanState()` returns the initial
 *    `active: false, status: "draft"`.
 * 2. Valid transitions:
 *    - `enter` (inactive → active draft)
 *    - `edit` (draft → draft, plan text updated)
 *    - `propose` (draft → proposed)
 *    - `approve` (proposed → approved)
 *    - `reject` (any active → rejected)
 *    - `exit` (active → inactive)
 * 3. Invalid transitions throw:
 *    - `enter` on an active session
 *    - `approve` on a draft (must propose first)
 *    - `exit` on an inactive session
 *    - `edit` on a proposed plan
 *
 * **Hermetic:** pure function tests, no I/O.
 */

import { describe, expect, it } from "vitest";

import {
  PlanTransitionError,
  applyTransition,
  createPlanState,
} from "../../src/plan/state.js";

describe("createPlanState", () => {
  it("returns the initial inactive draft state", () => {
    const s = createPlanState(() => "2026-08-21T00:00:00Z");
    expect(s.active).toBe(false);
    expect(s.planText).toBe("");
    expect(s.reviewStatus).toBe("draft");
    expect(s.updatedAt).toBe("2026-08-21T00:00:00Z");
  });

  it("uses the injected clock for updatedAt", () => {
    const s = createPlanState(() => "CUSTOM");
    expect(s.updatedAt).toBe("CUSTOM");
  });
});

describe("applyTransition — valid", () => {
  it("enter: inactive → active (draft)", () => {
    const s = createPlanState();
    const next = applyTransition(s, { kind: "enter" });
    expect(next.active).toBe(true);
    expect(next.reviewStatus).toBe("draft");
  });

  it("edit: draft → draft with plan text updated", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    s = applyTransition(s, { kind: "edit", planText: "step 1: do X" });
    expect(s.planText).toBe("step 1: do X");
    expect(s.reviewStatus).toBe("draft");
  });

  it("edit: rejected → draft (re-edit after rejection)", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    s = applyTransition(s, { kind: "propose" });
    s = applyTransition(s, { kind: "reject", reason: "no" });
    expect(s.reviewStatus).toBe("rejected");
    s = applyTransition(s, { kind: "edit", planText: "step 1: do X" });
    expect(s.reviewStatus).toBe("draft");
    expect(s.planText).toBe("step 1: do X");
  });

  it("propose: draft → proposed", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    s = applyTransition(s, { kind: "edit", planText: "p" });
    s = applyTransition(s, { kind: "propose" });
    expect(s.reviewStatus).toBe("proposed");
  });

  it("approve: proposed → approved", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    s = applyTransition(s, { kind: "edit", planText: "p" });
    s = applyTransition(s, { kind: "propose" });
    s = applyTransition(s, { kind: "approve" });
    expect(s.reviewStatus).toBe("approved");
  });

  it("reject: any active → rejected (with reason)", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    s = applyTransition(s, { kind: "reject", reason: "incomplete" });
    expect(s.reviewStatus).toBe("rejected");
    expect(s.rejectionReason).toBe("incomplete");
  });

  it("reject: any active → rejected (no reason)", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    s = applyTransition(s, { kind: "reject" });
    expect(s.reviewStatus).toBe("rejected");
    expect(s.rejectionReason).toBeUndefined();
  });

  it("exit: active → inactive (keeps plan text + status)", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    s = applyTransition(s, { kind: "edit", planText: "p" });
    s = applyTransition(s, { kind: "propose" });
    s = applyTransition(s, { kind: "exit" });
    expect(s.active).toBe(false);
    expect(s.planText).toBe("p");
    expect(s.reviewStatus).toBe("proposed");
  });
});

describe("applyTransition — invalid", () => {
  it("enter on an active session throws", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    expect(() => applyTransition(s, { kind: "enter" })).toThrow(
      PlanTransitionError,
    );
  });

  it("edit on an inactive session throws", () => {
    const s = createPlanState();
    expect(() =>
      applyTransition(s, { kind: "edit", planText: "p" }),
    ).toThrow(/plan mode is not active/);
  });

  it("edit on a proposed plan throws", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    s = applyTransition(s, { kind: "edit", planText: "p" });
    s = applyTransition(s, { kind: "propose" });
    expect(() =>
      applyTransition(s, { kind: "edit", planText: "p2" }),
    ).toThrow(/cannot edit a plan in status 'proposed'/);
  });

  it("approve on a draft (must propose first) throws", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    expect(() => applyTransition(s, { kind: "approve" })).toThrow(
      /cannot approve a plan in status 'draft'/,
    );
  });

  it("approve on an approved plan throws (no re-approve)", () => {
    let s = createPlanState();
    s = applyTransition(s, { kind: "enter" });
    s = applyTransition(s, { kind: "edit", planText: "p" });
    s = applyTransition(s, { kind: "propose" });
    s = applyTransition(s, { kind: "approve" });
    expect(() => applyTransition(s, { kind: "approve" })).toThrow(
      /cannot approve a plan in status 'approved'/,
    );
  });

  it("exit on an inactive session throws", () => {
    const s = createPlanState();
    expect(() => applyTransition(s, { kind: "exit" })).toThrow(
      /plan mode is not active/,
    );
  });
});
