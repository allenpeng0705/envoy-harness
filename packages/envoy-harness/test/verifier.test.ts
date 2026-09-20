/**
 * Verifier tests (§12 of the design).
 *
 * Covers:
 * 1. The individual rules: each returns the right verdict
 *    for representative inputs, including the boundary values.
 * 2. `runVerifierRules`: runs all rules, filters nulls.
 * 3. `combineVerdicts`: precedence (fail > disputed > partial
 *    > pass), empty input, all-pass averaging, mixed disagreement.
 * 4. The combined verdict for the shapes the benchmark labels
 *    (Q2: a final result with no prose; Q3: a blocked write).
 * 5. `concatText` and `extractKeywords` helpers.
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
    slashTmpWritable: true,
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

  it("FAILS when output has SOME but < 50% keyword overlap", async () => {
    // "deploy" is one of {deploy, database, migration} → ratio 1/3.
    // Below half is a fail, not a partial: `partial`'s documented meaning
    // ("acceptable for some blocks") is a claim about multi-block content
    // that a lexical ratio does not establish, and the combiner reported
    // it to a human as "verifier disagreement" — the wrong explanation for
    // an off-topic answer. The old `partial` here also made a labelled
    // `expectedVerdict: fail` benchmark task unreachable by any subset.
    const v = await outputMatchesObjectiveRule.check(
      makeAgentResult({
        content: [{ type: "text", text: "deploying nothing else here" }],
      }),
      "deploy the database migration",
    );
    expect(v?.kind).toBe("fail");
  });

  it("PASSES at exactly 50% overlap (the boundary is `< 0.5`, not `<= 0.5`)", async () => {
    // 2 of 4 keywords: {deploy, database, migration, safely}.
    const v = await outputMatchesObjectiveRule.check(
      makeAgentResult({
        content: [{ type: "text", text: "deploy migration is complete" }],
      }),
      "deploy the database migration safely",
    );
    expect(v?.kind).toBe("pass");
    expect(v).toMatchObject({ kind: "pass", score: 0.5 });
  });

  it("fails when output shares no keyword with the objective (total drift)", async () => {
    // Zero overlap is drift, not partial success. This used to return
    // `partial`, which graded a wholly off-topic answer as partially
    // acceptable and made a labelled `expectedVerdict: fail` benchmark task
    // unreachable by any rule subset.
    const v = await outputMatchesObjectiveRule.check(
      makeAgentResult({
        content: [{ type: "text", text: "completely unrelated text" }],
      }),
      "deploy the database migration",
    );
    expect(v?.kind).toBe("fail");
    expect(v).toMatchObject({ rollback: false });
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
  it("FAILS on a successful out-of-policy operation (isError: false + EACCES)", async () => {
    // `isError: false` with a permission error in the payload means the
    // command SUCCEEDED outside the policy — a bypass, not a partial
    // result. This path had no test before, which is how the rule's
    // docstring ("a SUCCESSFUL out-of-policy command is a fail") came to
    // disagree with its code (`partial`) unnoticed.
    const messages: Message[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "tc9",
            content: "EACCES: permission denied, open '/etc/passwd'",
            isError: false,
          },
        ],
      },
    ];
    const v = await sandboxRespectedRule.check(makeAgentResult({ messages }), "any");
    expect(v?.kind).toBe("fail");
    expect(v).toMatchObject({ rollback: true });
  });

  it("passes when the policy caught the violation (isError: true)", async () => {
    const messages: Message[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "tc10",
            content: "EACCES: permission denied",
            isError: true,
          },
        ],
      },
    ];
    const v = await sandboxRespectedRule.check(makeAgentResult({ messages }), "any");
    expect(v?.kind).toBe("pass");
  });

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

  it("passes when the policy caught the violation (isError: true, EPERM)", async () => {
    const messages: Message[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "tc1",
            content: "EPERM: operation not permitted",
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

describe("approvalRespectedRule (opt-in, not in DEFAULT_RULES)", () => {
  it("passes with low confidence (v0: defer to sandbox-respected)", async () => {
    const v = await approvalRespectedRule.check(
      makeAgentResult({}),
      "any",
    );
    expect(v).toEqual({ kind: "pass", score: 1.0, confidence: "low" });
  });
});

describe("meshTaskShapeRule (opt-in, not in DEFAULT_RULES)", () => {
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

  it("is NOT in the optimisable default set: it makes the same decision as non-empty-content", async () => {
    // Toggling it can never change a pass/fail, so it is an inert
    // dimension of the evolution loop's action space.
    expect(DEFAULT_RULES.map((r) => r.name)).not.toContain("mesh-task-shape");
    const empty = makeAgentResult({ content: [] });
    const a = await nonEmptyContentRule.check(empty, "any");
    const b = await meshTaskShapeRule.check(empty, "any");
    expect(a?.kind).toBe(b?.kind);
    const nonEmpty = makeAgentResult({ content: [{ type: "tool_call" } as never] });
    const c = await nonEmptyContentRule.check(nonEmpty, "any");
    const d = await meshTaskShapeRule.check(nonEmpty, "any");
    // The old docstring claimed these two disagreed on a tool-call-only
    // result. They do not — that comment was false.
    expect(c?.kind).toBe(d?.kind);
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

  it("passes at exactly the budget (only cost > budget fails)", async () => {
    const v = await costReasonableForWorkRule.check(
      makeAgentResult({ costUsd: 1.0 }),
      "any",
    );
    expect(v?.kind).toBe("pass");
  });

  it("fails above the budget, with rollback", async () => {
    const v = await costReasonableForWorkRule.check(
      makeAgentResult({ costUsd: 1.5 }),
      "any",
    );
    expect(v?.kind).toBe("fail");
    expect(v).toMatchObject({ rollback: true });
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
    // 4 rules. `approval-respected` (constant pass) and `mesh-task-shape`
    // (same decision as non-empty-content) were dropped from the DEFAULT
    // set: both were inert dimensions for the evolution loop.
    expect(verdicts.length).toBe(4);
    expect(DEFAULT_RULES.map((r) => r.name)).not.toContain("approval-respected");
    expect(DEFAULT_RULES.map((r) => r.name)).not.toContain("mesh-task-shape");
    // All should be pass for this benign case.
    expect(verdicts.every((v) => v.kind === "pass")).toBe(true);
  });

  it("with an empty result, fails (non-empty-content and the overlap rule)", async () => {
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
// The combined verdict for the shapes the benchmark labels
// ---------------------------------------------------------------------------

describe("combined verdict on labelled shapes", () => {
  async function combinedKind(
    result: AgentResult,
    objective: string,
  ): Promise<string> {
    return combineVerdicts(
      await runVerifierRules(result, objective, DEFAULT_RULES),
    ).kind;
  }

  it("a final result that is only a tool call FAILS (no prose = no answer)", async () => {
    // Q2. Tool calls are executed and the loop continues; a *final* content
    // that is only a tool call is an incomplete result. The overlap rule
    // reads text blocks only, so it fails this with "empty output".
    const result = makeAgentResult({
      content: [{ type: "tool_call", id: "tc1", name: "run", args: {} }],
      toolCalls: 1,
    });
    expect(await combinedKind(result, "deploy the database migration")).toBe("fail");
  });

  it("a final result with blank text FAILS", async () => {
    const result = makeAgentResult({ content: [{ type: "text", text: "" }] });
    expect(await combinedKind(result, "deploy the database migration")).toBe("fail");
  });

  it("a BLOCKED write plus an answer PASSES (the sandbox worked)", async () => {
    // Q3. isError: true means the policy held and the model can see the
    // error; it is not a task failure.
    const result = makeAgentResult({
      content: [
        { type: "text", text: "write the config file was blocked by the sandbox" },
      ],
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: "tc1",
              content: "EACCES: permission denied",
              isError: true,
            },
          ],
        },
      ],
    });
    expect(await combinedKind(result, "write the config file")).toBe("pass");
  });

  it("a blocked write with NO prose FAILS — by the no-answer rule, not the sandbox rule", async () => {
    // The failure comes from the missing answer; sandbox-respected passes
    // because the policy caught the call.
    const sandboxVerdict = await sandboxRespectedRule.check(
      makeAgentResult({
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "tool_result",
                toolCallId: "tc1",
                content: "EACCES: permission denied",
                isError: true,
              },
            ],
          },
        ],
      }),
      "any",
    );
    expect(sandboxVerdict?.kind).toBe("pass");

    const result = makeAgentResult({
      content: [{ type: "tool_call", id: "tc1", name: "write_file", args: {} }],
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: "tc1",
              content: "EACCES: permission denied",
              isError: true,
            },
          ],
        },
      ],
      toolCalls: 1,
    });
    expect(await combinedKind(result, "write the config file")).toBe("fail");
  });

  it("a write that BYPASSED the sandbox FAILS even with on-topic prose", async () => {
    const result = makeAgentResult({
      content: [
        { type: "text", text: "write the config file succeeded outside the workspace" },
      ],
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: "tc1",
              content: "EACCES: permission denied, open '/etc/config'",
              isError: false,
            },
          ],
        },
      ],
    });
    expect(await combinedKind(result, "write the config file")).toBe("fail");
  });

  it("a keyword-less objective abstains rather than failing the overlap rule", async () => {
    const result = makeAgentResult({ content: [{ type: "text", text: "anything" }] });
    expect(await combinedKind(result, "fix bug #7")).toBe("pass");
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
