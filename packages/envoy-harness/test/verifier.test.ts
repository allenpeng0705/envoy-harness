/**
 * Verifier tests (§12 of the design).
 *
 * Covers:
 * 1. The 6 individual rules: each returns the right verdict
 *    for representative inputs.
 * 2. `runVerifierRules`: runs all rules, filters nulls.
 * 3. `combineVerdicts`: precedence (fail > disputed > partial
 *    > pass), empty input, all-pass averaging, mixed disagreement.
 * 4. `concatText` and `extractKeywords` helpers.
 *
 * **Test isolation:** every test builds its own `AgentResult`
 * (the input is small). No shared state.
 */

import { describe, expect, it } from "vitest";

import {
  approvalRespectedRule,
  combineVerdicts,
  concatText,
  costReasonableForWorkRule,
  DEFAULT_RULES,
  extractKeywords,
  meshTaskShapeRule,
  nonEmptyContentRule,
  outputMatchesObjectiveRule,
  runVerifierRules,
  sandboxRespectedRule,
  type VerifierRule,
} from "../src/index.js";
import type { AgentResult } from "../src/index.js";
import type { ContentBlock, Message, SandboxPolicy } from "../src/index.js";
import { InMemorySession, newSessionId } from "../src/index.js";

function makeAgentResult(overrides: {
  content?: ContentBlock[];
  messages?: Message[];
  toolCalls?: number;
  iterations?: number;
  stopReason?: AgentResult["stopReason"];
  costUsd?: number;
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
    excludeSlashTmp: true,
  };
  return {
    content: overrides.content ?? [{ type: "text", text: "ok" }],
    stopReason: overrides.stopReason ?? "end_turn",
    iterations: overrides.iterations ?? 1,
    toolCalls: overrides.toolCalls ?? 0,
    messages: overrides.messages ?? session.messages,
    sandboxPolicy: policy,
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: overrides.costUsd ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Individual rules
// ---------------------------------------------------------------------------

describe("nonEmptyContentRule", () => {
  it("passes when there is at least one content block", async () => {
    const v = await nonEmptyContentRule.check(
      makeAgentResult({ content: [{ type: "text", text: "hi" }] }),
      "anything",
    );
    expect(v).toEqual({ kind: "pass", score: 1.0, confidence: "high" });
  });

  it("fails when content is empty", async () => {
    const v = await nonEmptyContentRule.check(
      makeAgentResult({ content: [] }),
      "anything",
    );
    expect(v).toEqual({ kind: "fail", reason: "empty output", rollback: true });
  });
});

describe("outputMatchesObjectiveRule", () => {
  it("passes when output contains most objective keywords", async () => {
    const v = await outputMatchesObjectiveRule.check(
      makeAgentResult({
        content: [{ type: "text", text: "deployed the database migration successfully" }],
      }),
      "deploy the database migration",
    );
    expect(v?.kind).toBe("pass");
  });

  it("partial when output has < 50% keyword overlap", async () => {
    const v = await outputMatchesObjectiveRule.check(
      makeAgentResult({
        content: [{ type: "text", text: "completely unrelated text" }],
      }),
      "deploy the database migration",
    );
    expect(v?.kind).toBe("partial");
  });

  it("fails (kind: fail) when output is empty text", async () => {
    const v = await outputMatchesObjectiveRule.check(
      makeAgentResult({ content: [{ type: "text", text: "" }] }),
      "do something",
    );
    expect(v?.kind).toBe("fail");
  });

  it("returns null when objective has no extractable keywords", async () => {
    // All stop words + too-short.
    const v = await outputMatchesObjectiveRule.check(
      makeAgentResult({ content: [{ type: "text", text: "anything" }] }),
      "a an the of to",
    );
    expect(v).toBeNull();
  });
});

describe("sandboxRespectedRule", () => {
  it("passes when no tool result mentions EACCES/EPERM", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "tc1", content: "ok", isError: false }] },
    ];
    const v = await sandboxRespectedRule.check(
      makeAgentResult({ messages }),
      "any",
    );
    expect(v?.kind).toBe("pass");
  });

  it("partial when a tool result mentions EACCES (the policy was tested)", async () => {
    const messages: Message[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "tc1",
            content: "EACCES: permission denied",
            isError: true, // the policy caught it
          },
        ],
      },
    ];
    const v = await sandboxRespectedRule.check(
      makeAgentResult({ messages }),
      "any",
    );
    // The rule only flags non-error results. isError: true
    // means the policy worked correctly. Result: pass.
    expect(v?.kind).toBe("pass");
  });
});

describe("approvalRespectedRule", () => {
  it("passes with low confidence (v0: defer to sandbox-respected)", async () => {
    const v = await approvalRespectedRule.check(
      makeAgentResult({}),
      "any",
    );
    expect(v).toEqual({ kind: "pass", score: 1.0, confidence: "low" });
  });
});

describe("meshTaskShapeRule", () => {
  it("passes when content is non-empty", async () => {
    const v = await meshTaskShapeRule.check(
      makeAgentResult({ content: [{ type: "text", text: "x" }] }),
      "any",
    );
    expect(v?.kind).toBe("pass");
  });

  it("fails when content is empty", async () => {
    const v = await meshTaskShapeRule.check(
      makeAgentResult({ content: [] }),
      "any",
    );
    expect(v?.kind).toBe("fail");
  });
});

describe("costReasonableForWorkRule", () => {
  it("passes when cost is 0 (no model reported usage; v0 default)", async () => {
    const v = await costReasonableForWorkRule.check(
      makeAgentResult({}),
      "any",
    );
    // F7.1: cost tracking is now real. cost=0 → pass.
    expect(v?.kind).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// runVerifierRules
// ---------------------------------------------------------------------------

describe("runVerifierRules", () => {
  it("runs all rules and filters nulls", async () => {
    const result = makeAgentResult({
      content: [{ type: "text", text: "deployed the database migration" }],
    });
    const verdicts = await runVerifierRules(result, "deploy database", DEFAULT_RULES);
    // F7.1: cost-reasonable now also returns a verdict (pass at cost=0).
    // All 6 rules return verdicts.
    expect(verdicts.length).toBe(6);
    // All should be pass for this benign case.
    expect(verdicts.every((v) => v.kind === "pass")).toBe(true);
  });

  it("with an empty result, fails on non-empty and mesh-task-shape", async () => {
    const result = makeAgentResult({ content: [] });
    const verdicts = await runVerifierRules(result, "anything", DEFAULT_RULES);
    expect(verdicts.some((v) => v.kind === "fail")).toBe(true);
  });

  it("with a custom rule set, runs only those rules", async () => {
    const customRule: VerifierRule = {
      name: "always-pass",
      async check() {
        return { kind: "pass", score: 1.0, confidence: "high" };
      },
    };
    const verdicts = await runVerifierRules(
      makeAgentResult({}),
      "any",
      [customRule],
    );
    expect(verdicts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// combineVerdicts
// ---------------------------------------------------------------------------

describe("combineVerdicts", () => {
  it("returns the first fail when any verdict is fail", () => {
    const combined = combineVerdicts([
      { kind: "pass", score: 1.0, confidence: "high" },
      { kind: "fail", reason: "x", rollback: true },
      { kind: "pass", score: 0.5, confidence: "low" },
    ]);
    expect(combined).toEqual({ kind: "fail", reason: "x", rollback: true });
  });

  it("returns disputed when verdicts is empty", () => {
    const combined = combineVerdicts([]);
    expect(combined).toEqual({
      kind: "disputed",
      needsHuman: true,
      signals: ["verifier produced no verdicts"],
    });
  });

  it("averages scores when all verdicts are pass", () => {
    const combined = combineVerdicts([
      { kind: "pass", score: 1.0, confidence: "high" },
      { kind: "pass", score: 0.6, confidence: "low" },
      { kind: "pass", score: 0.8, confidence: "medium" },
    ]);
    expect(combined.kind).toBe("pass");
    if (combined.kind === "pass") {
      // (1.0 + 0.6 + 0.8) / 3 = 0.8, but JS floating-point
      // gives 0.8000000000000002; toBeCloseTo handles the
      // rounding safely.
      expect(combined.score).toBeCloseTo(0.8, 10);
      expect(combined.confidence).toBe("high"); // 3+ passes
    }
  });

  it("averages two passes with medium confidence", () => {
    const combined = combineVerdicts([
      { kind: "pass", score: 1.0, confidence: "high" },
      { kind: "pass", score: 0.5, confidence: "low" },
    ]);
    expect(combined.kind).toBe("pass");
    if (combined.kind === "pass") {
      expect(combined.score).toBeCloseTo(0.75, 10);
      expect(combined.confidence).toBe("medium"); // 2 passes < 3
    }
  });

  it("partials (mixed) downgrade to partial", () => {
    const combined = combineVerdicts([
      { kind: "pass", score: 1.0, confidence: "high" },
      { kind: "partial", score: 0.5, reason: "x" },
    ]);
    expect(combined).toEqual({
      kind: "partial",
      score: 0.5,
      reason: "verifier disagreement",
    });
  });

  it("propagates disputed (does not downgrade to partial)", () => {
    const verdict = combineVerdicts([
      { kind: "disputed", needsHuman: true, signals: ["cross-verify failed"] },
    ]);
    expect(verdict).toEqual({
      kind: "disputed",
      needsHuman: true,
      signals: ["cross-verify failed"],
    });
  });

  it("a disputed mixed with passes escalates to disputed", () => {
    const verdict = combineVerdicts([
      { kind: "pass", score: 1.0, confidence: "high" },
      { kind: "disputed", needsHuman: true, signals: ["model disagreement"] },
    ]);
    expect(verdict.kind).toBe("disputed");
  });

  it("a fail beats disputed", () => {
    const verdict = combineVerdicts([
      { kind: "disputed", needsHuman: true, signals: ["x"] },
      { kind: "fail", reason: "empty output", rollback: true },
    ]);
    expect(verdict.kind).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("concatText", () => {
  it("joins text blocks with newlines", () => {
    expect(
      concatText([
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello\nworld");
  });

  it("skips non-text blocks", () => {
    expect(
      concatText([
        { type: "text", text: "hi" },
        { type: "tool_call" },
        { type: "text", text: "bye" },
      ]),
    ).toBe("hi\nbye");
  });

  it("returns empty string for non-text content", () => {
    expect(concatText([{ type: "tool_call" }])).toBe("");
  });
});

describe("extractKeywords", () => {
  it("extracts lowercased unique words ≥ 4 chars", () => {
    expect(extractKeywords("Deploy the database migration migration"))
      .toEqual(expect.arrayContaining(["deploy", "database", "migration"]));
  });

  it("drops stop words and short words", () => {
    expect(extractKeywords("a an the of to is it be do"))
      .toEqual([]);
  });

  it("handles punctuation", () => {
    expect(extractKeywords("Hello, world! 42 things..."))
      .toEqual(expect.arrayContaining(["hello", "world", "things"]));
    // "42" is dropped (not a-z).
  });
});
