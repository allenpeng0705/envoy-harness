/**
 * R4.10 — verify session budget.
 */

import { describe, expect, it } from "vitest";

import { VerifySessionBudget } from "../../src/index.js";

describe("VerifySessionBudget", () => {
  it("allows N verifies then skips with an explicit reason", () => {
    const budget = new VerifySessionBudget({
      maxVerificationsPerSession: 2,
      scopeLabel: "test-session",
    });
    expect(budget.take().allowed).toBe(true);
    expect(budget.take().allowed).toBe(true);
    const third = budget.take();
    expect(third.allowed).toBe(false);
    if (!third.allowed) {
      expect(third.skip.reason).toContain("verify budget exhausted");
      expect(third.skip.reason).toContain("test-session");
      expect(third.skip.used).toBe(2);
      expect(third.skip.max).toBe(2);
    }
  });

  it("max 0 skips immediately", () => {
    const budget = new VerifySessionBudget({
      maxVerificationsPerSession: 0,
    });
    const d = budget.tryReserve();
    expect(d.allowed).toBe(false);
  });
});
