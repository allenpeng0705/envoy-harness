/**
 * Cost tracking tests (F7.1, §14 of the design).
 *
 * Covers:
 * 1. `computeCost` — pure math against the pricing table.
 * 2. `CostTracker` — accumulates usage, computes total.
 * 3. `costReasonableForWorkRule` — passes under budget,
 *    fails over, abstains at zero.
 * 4. `ModelResponse.usage` + `AgentResult.metrics` — type
 *    plumbing (the agent's loop wires these together).
 */

import { describe, expect, it } from "vitest";

import {
  CostTracker,
  computeCost,
  costReasonableForWorkRule,
  DEFAULT_PRICING,
  InMemorySession,
  newSessionId,
  type AgentResult,
  type ContentBlock,
  type Message,
  type SandboxPolicy,
  type TokenPrice,
} from "../src/index.js";

/** Build a minimal AgentResult for the verifier rule tests. */
function makeAgentResult(overrides: {
  costUsd?: number;
  content?: ContentBlock[];
  messages?: Message[];
}): AgentResult {
  const session = new InMemorySession(newSessionId(), {
    cwd: "/tmp",
    permissionMode: "workspace-write",
    startedAt: new Date().toISOString(),
  });
  const policy: SandboxPolicy = {
    mode: "workspace-write",
    approval: "on-request",
    backend: "linux-landlock",
    writableRoots: ["/tmp"],
    networkAccess: false,
    slashTmpWritable: true,
  };
  return {
    content: overrides.content ?? [{ type: "text", text: "ok" }],
    stopReason: "end_turn",
    iterations: 1,
    toolCalls: 0,
    messages: overrides.messages ?? session.messages,
    sandboxPolicy: policy,
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: overrides.costUsd ?? 0,
    },
  };
}

describe("computeCost", () => {
  it("returns 0 for an unknown model (graceful default)", () => {
    expect(computeCost("unknown-model", 1000, 500)).toBe(0);
  });

  it("computes the cost for gpt-4o correctly", () => {
    // gpt-4o: $2.5 / 1M input, $10 / 1M output.
    // 1M input + 1M output = $2.5 + $10 = $12.5
    expect(computeCost("gpt-4o", 1_000_000, 1_000_000)).toBeCloseTo(12.5, 6);
  });

  it("computes the cost for claude-sonnet-4-6 correctly", () => {
    // $3 / 1M input, $15 / 1M output.
    // 1M input + 1M output = $18
    expect(computeCost("claude-sonnet-4-6", 1_000_000, 1_000_000)).toBeCloseTo(18, 6);
  });

  it("computes the cost for deepseek-chat correctly", () => {
    // $0.14 / 1M input, $0.28 / 1M output.
    // 1M input + 1M output = $0.42
    expect(computeCost("deepseek-chat", 1_000_000, 1_000_000)).toBeCloseTo(0.42, 6);
  });

  it("handles sub-cent costs correctly (rounds to 6 decimal places)", () => {
    // 100 input tokens at gpt-4o ($2.5/1M) = $0.00025
    const cost = computeCost("gpt-4o", 100, 0);
    expect(cost).toBe(0.00025);
  });

  it("accepts a custom pricing table", () => {
    const custom: Record<string, TokenPrice> = {
      "test-model": { inputUsdPerMTok: 100, outputUsdPerMTok: 200 },
    };
    // 1M input + 1M output = $100 + $200 = $300
    expect(computeCost("test-model", 1_000_000, 1_000_000, custom)).toBeCloseTo(300, 6);
  });
});

describe("DEFAULT_PRICING", () => {
  it("has entries for OpenAI, Anthropic, and DeepSeek models", () => {
    expect(DEFAULT_PRICING["gpt-4o"]).toBeDefined();
    expect(DEFAULT_PRICING["gpt-4o-mini"]).toBeDefined();
    expect(DEFAULT_PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(DEFAULT_PRICING["claude-haiku-4"]).toBeDefined();
    expect(DEFAULT_PRICING["deepseek-chat"]).toBeDefined();
  });

  it("every entry has positive input and output prices (or zero for 'local')", () => {
    for (const [model, price] of Object.entries(DEFAULT_PRICING)) {
      expect(price.inputUsdPerMTok, `${model} input price`).toBeGreaterThanOrEqual(0);
      expect(price.outputUsdPerMTok, `${model} output price`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("CostTracker", () => {
  it("starts at zero", () => {
    const t = new CostTracker({ model: "gpt-4o" });
    expect(t.total()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("accumulates usage across multiple addUsage calls", () => {
    const t = new CostTracker({ model: "gpt-4o" });
    t.addUsage({ inputTokens: 1000, outputTokens: 500 });
    t.addUsage({ inputTokens: 2000, outputTokens: 1000 });
    const total = t.total();
    expect(total.inputTokens).toBe(3000);
    expect(total.outputTokens).toBe(1500);
    // 3000 input at $2.5/1M = $0.0075
    // 1500 output at $10/1M = $0.015
    // Total: $0.0225
    expect(total.costUsd).toBeCloseTo(0.0225, 6);
  });

  it("uses modelOverride for per-call pricing (multi-model runs)", () => {
    const t = new CostTracker({ model: "gpt-4o" });
    t.addUsage({ inputTokens: 1_000_000, outputTokens: 0 });
    t.addUsage({ inputTokens: 1_000_000, outputTokens: 0 }, "claude-haiku-4");
    // 1M gpt-4o input = $2.5
    // 1M claude-haiku-4 input = $1.0
    // Total: $3.5
    expect(t.total().costUsd).toBeCloseTo(3.5, 6);
  });

  it("counts tokens for unknown models (just doesn't add cost)", () => {
    const t = new CostTracker({ model: "gpt-4o" });
    t.addUsage({ inputTokens: 1000, outputTokens: 500 }, "unknown");
    const total = t.total();
    expect(total.inputTokens).toBe(1000);
    expect(total.outputTokens).toBe(500);
    expect(total.costUsd).toBe(0);
  });

  it("reset() clears the totals", () => {
    const t = new CostTracker({ model: "gpt-4o" });
    t.addUsage({ inputTokens: 1000, outputTokens: 500 });
    t.reset();
    expect(t.total().costUsd).toBe(0);
  });

  it("setModel changes the default for subsequent addUsage calls", () => {
    const t = new CostTracker({ model: "gpt-4o" });
    t.setModel("claude-haiku-4");
    t.addUsage({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(t.total().costUsd).toBeCloseTo(1.0, 6);
  });
});

describe("costReasonableForWorkRule (verifier)", () => {
  it("passes when cost is 0 (no model reported usage)", async () => {
    const v = await costReasonableForWorkRule.check(makeAgentResult({}), "any");
    expect(v?.kind).toBe("pass");
  });

  it("passes when cost is under the $1 budget", async () => {
    const v = await costReasonableForWorkRule.check(
      makeAgentResult({ costUsd: 0.5 }),
      "any",
    );
    expect(v?.kind).toBe("pass");
  });

  it("fails with rollback when cost exceeds the $1 budget", async () => {
    const v = await costReasonableForWorkRule.check(
      makeAgentResult({ costUsd: 2.5 }),
      "any",
    );
    expect(v?.kind).toBe("fail");
    if (v?.kind === "fail") {
      expect(v.reason).toMatch(/exceeds budget/);
      expect(v.rollback).toBe(true);
    }
  });

  it("computes score as cost/budget", async () => {
    const v = await costReasonableForWorkRule.check(
      makeAgentResult({ costUsd: 0.5 }),
      "any",
    );
    expect(v?.kind).toBe("pass");
    if (v?.kind === "pass") {
      expect(v.score).toBeCloseTo(0.5, 6);
    }
  });
});
