/**
 * Cost tracking (§14 of the design).
 *
 * **What is the cost module?** a small surface for "given a
 * model and a token count, how much does this cost?" plus a
 * `CostTracker` that accumulates usage across a run.
 *
 * **Why is this in its own module?** the design puts cost
 * tracking on the PostToolUse hook (so cost is attributed
 * to the call that produced it). v0 has cost as a first-class
 * field on `AgentResult.metrics`; the hook can populate it
 * by inspecting the model's last response. Keeping the math
 * in a separate module means a unit test verifies the math,
 * not the hook.
 *
 * **Pricing table:** the `DEFAULT_PRICING` is a static table
 * (USD per million tokens, input + output). Real-world
 * pricing changes often; v0 ships a baseline that the
 * operator can override via `CostTracker({ pricing })`. A
 * future chunk can plug in a live pricing source.
 *
 * **v0 simplification:** we don't track cache tokens
 * (Anthropic) or reasoning tokens (o1). The `usage` shape
 * is intentionally minimal: `inputTokens + outputTokens`.
 * A future chunk can extend the type and the pricing math
 * if needed.
 *
 * **Stability:** `TokenPrice`, `DEFAULT_PRICING`,
 * `computeCost`, and `CostTracker` are the public API. New
 * model entries are additive; removing one is a major
 * version bump (callers may rely on it).
 */

// ---------------------------------------------------------------------------
// TokenPrice + DEFAULT_PRICING
// ---------------------------------------------------------------------------

/** USD per million tokens (input + output, separately). */
export interface TokenPrice {
  /** USD per million input tokens. */
  inputUsdPerMTok: number;
  /** USD per million output tokens. */
  outputUsdPerMTok: number;
}

/**
 * A static pricing table for the providers we support in v0.
 * Numbers are USD per million tokens, as of 2026.
 *
 * **Override at construction:** `CostTracker({ pricing })`
 * lets the operator pass a custom table. The default is a
 * snapshot; pricing in production is a separate concern
 * (live pricing source, billing dashboard, etc.).
 *
 * **Why a Record (not a Map):** `Record<string, TokenPrice>`
 * is JSON-serializable (cost may want to dump the table to
 * the scoreboard for the audit trail). Maps aren't.
 */
export const DEFAULT_PRICING: Record<string, TokenPrice> = {
  // OpenAI
  "gpt-4o":         { inputUsdPerMTok: 2.5,  outputUsdPerMTok: 10.0 },
  "gpt-4o-mini":    { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6 },
  "gpt-4.1":        { inputUsdPerMTok: 2.0,  outputUsdPerMTok: 8.0 },
  "gpt-4.1-mini":   { inputUsdPerMTok: 0.4,  outputUsdPerMTok: 1.6 },
  "gpt-5":          { inputUsdPerMTok: 5.0,  outputUsdPerMTok: 20.0 },
  // Anthropic
  "claude-sonnet-4-6": { inputUsdPerMTok: 3.0,  outputUsdPerMTok: 15.0 },
  "claude-haiku-4":    { inputUsdPerMTok: 1.0,  outputUsdPerMTok: 5.0 },
  "claude-opus-4":     { inputUsdPerMTok: 15.0, outputUsdPerMTok: 75.0 },
  // DeepSeek
  "deepseek-chat":     { inputUsdPerMTok: 0.14, outputUsdPerMTok: 0.28 },
  "deepseek-reasoner": { inputUsdPerMTok: 0.14, outputUsdPerMTok: 0.28 },
  // Local / unknown (treated as $0)
  "local":             { inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
};

// ---------------------------------------------------------------------------
// computeCost — pure function
// ---------------------------------------------------------------------------

/**
 * Compute the USD cost for a single request. Returns 0 when
 * the model is unknown to the pricing table (graceful default
 * for local models and future providers not yet priced).
 *
 * **The math:** `cost = (inputTokens / 1e6) * inputUsdPerMTok
 * + (outputTokens / 1e6) * outputUsdPerMTok`. Both halves
 * rounded to 6 decimal places (sub-cent precision is enough
 * for the dashboard; full precision would expose floating-point
 * noise in the JSON).
 */
export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricing: Record<string, TokenPrice> = DEFAULT_PRICING,
): number {
  const price = pricing[model];
  if (!price) return 0;
  const inputCost = (inputTokens / 1_000_000) * price.inputUsdPerMTok;
  const outputCost = (outputTokens / 1_000_000) * price.outputUsdPerMTok;
  // Round to 6 decimal places (sub-cent).
  return Math.round((inputCost + outputCost) * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// CostTracker — accumulates usage across a run
// ---------------------------------------------------------------------------

/** A single usage event (what the model adapter reports). */
export interface Usage {
  /** Tokens in the request (prompt). */
  inputTokens: number;
  /** Tokens in the response (completion). */
  outputTokens: number;
}

/** The accumulated state of a run. */
export interface RunCost {
  inputTokens: number;
  outputTokens: number;
  /** USD cost summed across all addUsage() calls. */
  costUsd: number;
}

/**
 * Accumulates usage across a run and computes total cost.
 * Used by the Agent loop: each model call adds its usage;
 * the AgentResult carries the final totals.
 *
 * **Why a class?** the loop calls `addUsage` multiple times
 * (one per model call). A class encapsulates the running
 * totals; the alternative (passing totals through the loop
 * state) is more error-prone.
 *
 * **Why is the model name configurable?** different
 * models in the same run (unlikely in v0, possible with
 * tool-call handoff in Phase 2) have different prices. The
 * tracker remembers the current model so each addUsage
 * uses the right pricing.
 */
export class CostTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;
  private model: string;
  private pricing: Record<string, TokenPrice>;

  constructor(options: {
    model: string;
    pricing?: Record<string, TokenPrice>;
  }) {
    this.model = options.model;
    this.pricing = options.pricing ?? DEFAULT_PRICING;
  }

  /**
   * Add a usage event. Updates the running totals and the
   * accumulated cost. Unknown models contribute 0 cost but
   * the tokens are still counted.
   */
  /**
   * The model name this tracker was constructed with.
   * Read-only. The agent emits this in the `agent_start`
   * trace event; the actual model may be different if
   * `addUsage` was called with a `modelOverride`.
   */
  get currentModel(): string {
    return this.model;
  }

  addUsage(usage: Usage, modelOverride?: string): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    const model = modelOverride ?? this.model;
    this.costUsd += computeCost(
      model,
      usage.inputTokens,
      usage.outputTokens,
      this.pricing,
    );
  }

  /**
   * Switch the model used for pricing. Use when a run
   * legitimately uses more than one model (rare in v0).
   */
  setModel(model: string): void {
    this.model = model;
  }

  /** The current totals. */
  total(): RunCost {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
    };
  }

  /** Reset the tracker (for reuse across runs). */
  reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.costUsd = 0;
  }
}
