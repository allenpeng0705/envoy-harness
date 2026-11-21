/**
 * formatJobSettlementNotice / formatSettlementNotice contracts.
 */

import { describe, expect, it } from "vitest";

import {
  formatJobSettlementNotice,
  formatSettlementNotice,
  JOB_SETTLEMENT_NOTICE_PREFIX,
  SETTLEMENT_NOTICE_PREFIX,
} from "../../src/subagent/settlement-notice.js";
import type { SubagentResult } from "../../src/subagent/types.js";

function result(
  status: SubagentResult["status"],
  content: SubagentResult["content"] = [],
): SubagentResult {
  return {
    status,
    content,
    workerPeerId: "local",
    workerRuntime: "envoy-harness",
    costUsd: 0,
    durationMs: 1,
    verdict:
      status === "completed"
        ? { kind: "pass", score: 1, confidence: "high" }
        : { kind: "fail", reason: "x", rollback: false },
    signature: "",
  };
}

describe("formatSettlementNotice", () => {
  it("summarizes completed / failed / partial and empty closing", () => {
    const completed = formatSettlementNotice({
      jobId: "j1",
      agentId: "a1",
      result: result("completed", [{ type: "text", text: "ok" }]),
    });
    expect(completed).toContain(SETTLEMENT_NOTICE_PREFIX);
    expect(completed).toContain("finished and will do no further work");
    expect(completed).toContain("Its closing message:\nok");

    const failed = formatSettlementNotice({
      jobId: "j2",
      agentId: "a2",
      result: result("failed"),
    });
    expect(failed).toContain("failed before it finished");
    expect(failed).toContain("It left no closing message.");

    const partial = formatSettlementNotice({
      jobId: "j3",
      agentId: "a3",
      result: result("partial", [{ type: "text", text: "halfway" }]),
    });
    expect(partial).toContain("ended with a partial result");
    expect(partial).toContain("halfway");
  });
});

describe("formatJobSettlementNotice", () => {
  it("includes prefix, kind, status, and label", () => {
    const text = formatJobSettlementNotice({
      id: "bash-9",
      kind: "bash",
      label: "build",
      status: "completed",
      startedAt: 1,
      finishedAt: 2,
    });
    expect(text).toContain(JOB_SETTLEMENT_NOTICE_PREFIX);
    expect(text).toContain("job=bash-9");
    expect(text).toContain("kind=bash");
    expect(text).toContain("status=completed");
    expect(text).toContain("build");
  });

  it("falls back to id when label is empty", () => {
    const text = formatJobSettlementNotice({
      id: "bash-2",
      kind: "bash",
      label: "",
      status: "failed",
      startedAt: 1,
    });
    expect(text).toContain("bash-2");
  });

  it("truncates long detail to 500 chars", () => {
    const detail = "x".repeat(600);
    const text = formatJobSettlementNotice({
      id: "bash-3",
      kind: "bash",
      label: "long",
      status: "failed",
      detail,
      startedAt: 1,
    });
    expect(text).toContain("Detail:");
    expect(text).toContain("x".repeat(500));
    expect(text).not.toContain("x".repeat(501));
  });
});
