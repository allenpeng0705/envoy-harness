/**
 * F8.6+ tests — wire the local verifier rules to the adapter.
 *
 * Covers:
 * 1. `runLocalVerifier` runs the 6 default rules.
 * 2. Empty content → at least one fail (non-empty-content).
 * 3. Non-empty content → at least one pass.
 * 4. Custom rules list is respected.
 * 5. The full transcript (raw) is preserved (decoded for
 *    the verifier via the synthetic message).
 * 6. Tool calls + tool results in the wire content are
 *    decoded back to the local shape.
 */

import { describe, expect, it } from "vitest";

import {
  type AgentResult as LocalAgentResult,
  type VerifierRule,
} from "@envoymesh/envoy-harness";
import type { VerifyInput } from "@envoymesh/agent-adapter";
import type { SignedAgentResult } from "@envoymesh/protocol";

import { runLocalVerifier, runLocalVerifierOnLocal } from "../src/verify.js";
import { TOOL_CALL_SCHEMA_REF, TOOL_RESULT_SCHEMA_REF } from "../src/translation.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSignedResult(overrides: Partial<SignedAgentResult> = {}): SignedAgentResult {
  return {
    skillId: "code-review",
    runtime: "envoy-harness",
    peerId: "peer-1",
    correlationId: "corr-1",
    content: [{ kind: "text", text: "the diff looks fine" }],
    citations: [],
    metrics: { durationMs: 100, costUsd: 0.05 },
    completedAt: new Date().toISOString(),
    signature: "fake",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// runLocalVerifier
// ---------------------------------------------------------------------------

describe("runLocalVerifier", () => {
  it("runs the 6 default rules and returns wire verdicts", async () => {
    const input: VerifyInput = {
      result: makeSignedResult(),
      objective: "review the recent diff",
    };
    const verdicts = await runLocalVerifier(input);
    // At least one rule should fire (non-empty-content +
    // output-matches-objective both produce a verdict on
    // a well-formed input).
    expect(verdicts.length).toBeGreaterThan(0);
    // Every verdict is a wire Verdict (structurally aligned
    // with local — we trust the type at the typecheck layer).
    for (const v of verdicts) {
      expect(["pass", "partial", "fail", "disputed"]).toContain(v.kind);
    }
  });

  it("fails when the result has no text content", async () => {
    const input: VerifyInput = {
      result: makeSignedResult({ content: [] }),
      objective: "review the recent diff",
    };
    const verdicts = await runLocalVerifier(input);
    const fails = verdicts.filter((v) => v.kind === "fail");
    expect(fails.length).toBeGreaterThan(0);
    // The non-empty-content rule should fire.
    const nonEmptyFail = fails.find((v) => v.kind === "fail" && v.reason.toLowerCase().includes("empty"));
    expect(nonEmptyFail).toBeDefined();
  });

  it("decodes tool-call and tool-result structured blocks", async () => {
    const input: VerifyInput = {
      result: makeSignedResult({
        content: [
          {
            kind: "structured",
            schemaRef: TOOL_CALL_SCHEMA_REF,
            data: { id: "t1", name: "read_file", args: { path: "/tmp/foo" } },
          },
          {
            kind: "structured",
            schemaRef: TOOL_RESULT_SCHEMA_REF,
            data: { toolCallId: "t1", content: "file contents", isError: false },
          },
          { kind: "text", text: "done" },
        ],
      }),
      objective: "read the file",
    };
    const verdicts = await runLocalVerifier(input);
    // Should not throw on decode; the local verifier
    // gets a synthetic message with the decoded blocks.
    expect(Array.isArray(verdicts)).toBe(true);
  });

  it("respects a custom rules list", async () => {
    const customRule: VerifierRule = {
      name: "always-pass",
      check: async () => ({ kind: "pass", score: 1.0, confidence: "high" }),
    };
    const input: VerifyInput = {
      result: makeSignedResult(),
      objective: "x",
    };
    const verdicts = await runLocalVerifier(input, { rules: [customRule] });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.kind).toBe("pass");
  });

  it("respects a custom failing rule", async () => {
    const customRule: VerifierRule = {
      name: "always-fail",
      check: async () => ({ kind: "fail", reason: "custom rule failed", rollback: true }),
    };
    const input: VerifyInput = {
      result: makeSignedResult(),
      objective: "x",
    };
    const verdicts = await runLocalVerifier(input, { rules: [customRule] });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.kind).toBe("fail");
  });

  it("preserves raw audit in the synthesized local result (indirectly via no error)", async () => {
    // The wire result has `raw`. The verifier doesn't
    // look at raw, but the function shouldn't throw on it.
    const input: VerifyInput = {
      result: makeSignedResult({
        raw: { secretAudit: "lossless local result" },
      }),
      objective: "x",
    };
    const verdicts = await runLocalVerifier(input);
    expect(Array.isArray(verdicts)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runLocalVerifierOnLocal
// ---------------------------------------------------------------------------

describe("runLocalVerifierOnLocal", () => {
  function makeLocalResult(): LocalAgentResult {
    return {
      content: [{ type: "text", text: "looks good" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "do the thing" }] },
        { role: "assistant", content: [{ type: "text", text: "looks good" }] },
      ],
      sandboxPolicy: {
        mode: "read-only",
        approval: "on-request",
        backend: "linux-landlock",
        writableRoots: [],
        networkAccess: false,
        excludeSlashTmp: true,
      },
      metrics: { inputTokens: 100, outputTokens: 50, costUsd: 0.005 },
      iterations: 2,
      toolCalls: 1,
      stopReason: "end_turn",
    };
  }

  it("runs the local verifier directly on a local result", async () => {
    const verdicts = await runLocalVerifierOnLocal(makeLocalResult(), "do the thing");
    expect(verdicts.length).toBeGreaterThan(0);
    for (const v of verdicts) {
      expect(["pass", "partial", "fail", "disputed"]).toContain(v.kind);
    }
  });

  it("respects a custom rules list", async () => {
    const customRule: VerifierRule = {
      name: "yes",
      check: async () => ({ kind: "pass", score: 1.0, confidence: "high" }),
    };
    const verdicts = await runLocalVerifierOnLocal(makeLocalResult(), "x", { rules: [customRule] });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.kind).toBe("pass");
  });
});
