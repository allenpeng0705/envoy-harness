/**
 * R4.10 — verify session budget.
 *
 * Caps expensive cross-model / post-execute verifications per session
 * (or other host-scoped unit). When exhausted, callers skip verify and
 * surface an explicit reason (telemetry-friendly).
 */

export interface VerifyBudgetSkip {
  /** Machine-readable reason for hosts / telemetry. */
  reason: string;
  /** How many verifies were already consumed. */
  used: number;
  /** Configured maximum. */
  max: number;
}

export type VerifyBudgetDecision =
  | { allowed: true; used: number; remaining: number }
  | { allowed: false; skip: VerifyBudgetSkip };

export interface VerifySessionBudgetOptions {
  /**
   * Maximum successful verify consumptions. When `undefined` or
   * `Infinity`, never skips. When `0`, every verify is skipped.
   */
  maxVerificationsPerSession: number;
  /** Optional label included in skip reasons (default `"session"`). */
  scopeLabel?: string;
}

/**
 * Shared counter for local verifier, `verifyAfterExecute`, and D5
 * `peer/verify` paths.
 */
export class VerifySessionBudget {
  private used = 0;
  private readonly max: number;
  private readonly scopeLabel: string;

  constructor(options: VerifySessionBudgetOptions) {
    this.max = options.maxVerificationsPerSession;
    this.scopeLabel = options.scopeLabel ?? "session";
  }

  /** Verifies already consumed. */
  getUsed(): number {
    return this.used;
  }

  getMax(): number {
    return this.max;
  }

  remaining(): number {
    if (!Number.isFinite(this.max)) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.max - this.used);
  }

  /**
   * Decide whether another verify may run. Does **not** consume —
   * call {@link consume} after a successful verify starts/completes.
   */
  tryReserve(): VerifyBudgetDecision {
    if (!Number.isFinite(this.max)) {
      return {
        allowed: true,
        used: this.used,
        remaining: Number.POSITIVE_INFINITY,
      };
    }
    if (this.used >= this.max) {
      return {
        allowed: false,
        skip: {
          reason: `verify budget exhausted for ${this.scopeLabel} (used ${this.used}/${this.max})`,
          used: this.used,
          max: this.max,
        },
      };
    }
    return {
      allowed: true,
      used: this.used,
      remaining: this.max - this.used,
    };
  }

  /** Record one verify consumption after it was allowed. */
  consume(): void {
    this.used += 1;
  }

  /**
   * Reserve + consume in one step when the caller will definitely run
   * verify. Returns skip decision when budget is exhausted.
   */
  take(): VerifyBudgetDecision {
    const decision = this.tryReserve();
    if (decision.allowed) this.consume();
    return decision;
  }
}
