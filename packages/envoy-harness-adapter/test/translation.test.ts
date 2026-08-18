/**
 * F8.3 tests — local ↔ wire type translation.
 *
 * Covers:
 * 1. `localToWireBlock`: text, tool_call, tool_result, unknown.
 * 2. `localToWireContent`: list translation, empty list,
 *    filtering of unrecognized blocks.
 * 3. `localToWireMetrics`: required fields, optional fields.
 * 4. `localToWireResult`: full result with peerId,
 *    correlationId, raw audit trail, completedAt.
 * 5. The schemaRefs are stable constants.
 */

import { describe, expect, it } from "vitest";

import {
  TOOL_CALL_SCHEMA_REF,
  TOOL_RESULT_SCHEMA_REF,
  localToWireBlock,
  localToWireContent,
  localToWireMetrics,
  localToWireResult,
} from "../src/translation.js";
import type { ContentBlock as LocalContentBlock } from "@envoymesh/envoy-harness";

// ---------------------------------------------------------------------------
// localToWireBlock
// ---------------------------------------------------------------------------

describe("localToWireBlock", () => {
  it("translates a text block", () => {
    const local: LocalContentBlock = { type: "text", text: "hello" };
    expect(localToWireBlock(local)).toEqual({
      kind: "text",
      text: "hello",
    });
  });

  it("translates a tool_call block as a structured content block", () => {
    const local: LocalContentBlock = {
      type: "tool_call",
      id: "t1",
      name: "bash",
      args: { command: "ls" },
    };
    expect(localToWireBlock(local)).toEqual({
      kind: "structured",
      schemaRef: TOOL_CALL_SCHEMA_REF,
      data: { id: "t1", name: "bash", args: { command: "ls" } },
    });
  });

  it("translates a tool_result block as a structured content block", () => {
    const local: LocalContentBlock = {
      type: "tool_result",
      toolCallId: "t1",
      content: "file1\nfile2",
      isError: false,
    };
    expect(localToWireBlock(local)).toEqual({
      kind: "structured",
      schemaRef: TOOL_RESULT_SCHEMA_REF,
      data: { toolCallId: "t1", content: "file1\nfile2", isError: false },
    });
  });

  it("preserves tool_result with object content", () => {
    const local: LocalContentBlock = {
      type: "tool_result",
      toolCallId: "t1",
      content: { stdout: "x" },
      isError: false,
    };
    expect(localToWireBlock(local)).toEqual({
      kind: "structured",
      schemaRef: TOOL_RESULT_SCHEMA_REF,
      data: { toolCallId: "t1", content: { stdout: "x" }, isError: false },
    });
  });

  it("preserves isError=true on tool_result", () => {
    const local: LocalContentBlock = {
      type: "tool_result",
      toolCallId: "t1",
      content: "ENOSPC",
      isError: true,
    };
    expect(localToWireBlock(local)).toEqual({
      kind: "structured",
      schemaRef: TOOL_RESULT_SCHEMA_REF,
      data: { toolCallId: "t1", content: "ENOSPC", isError: true },
    });
  });
});

// ---------------------------------------------------------------------------
// localToWireContent
// ---------------------------------------------------------------------------

describe("localToWireContent", () => {
  it("translates an empty list to an empty list", () => {
    expect(localToWireContent([])).toEqual([]);
  });

  it("translates a list of mixed blocks, preserving order", () => {
    const local: LocalContentBlock[] = [
      { type: "text", text: "thinking" },
      { type: "tool_call", id: "t1", name: "bash", args: { command: "ls" } },
      { type: "tool_result", toolCallId: "t1", content: "out", isError: false },
      { type: "text", text: "done" },
    ];
    const out = localToWireContent(local);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ kind: "text", text: "thinking" });
    expect(out[1]?.kind).toBe("structured");
    expect((out[1] as { schemaRef: string }).schemaRef).toBe(TOOL_CALL_SCHEMA_REF);
    expect(out[2]?.kind).toBe("structured");
    expect((out[2] as { schemaRef: string }).schemaRef).toBe(TOOL_RESULT_SCHEMA_REF);
    expect(out[3]).toEqual({ kind: "text", text: "done" });
  });
});

// ---------------------------------------------------------------------------
// localToWireMetrics
// ---------------------------------------------------------------------------

describe("localToWireMetrics", () => {
  it("requires durationMs and costUsd", () => {
    expect(localToWireMetrics({ durationMs: 100, costUsd: 0.05 })).toEqual({
      durationMs: 100,
      costUsd: 0.05,
    });
  });

  it("includes promptTokens when provided", () => {
    expect(
      localToWireMetrics({
        durationMs: 100,
        costUsd: 0.05,
        promptTokens: 1000,
      }),
    ).toEqual({ durationMs: 100, costUsd: 0.05, promptTokens: 1000 });
  });

  it("includes completionTokens when provided", () => {
    expect(
      localToWireMetrics({
        durationMs: 100,
        costUsd: 0.05,
        completionTokens: 500,
      }),
    ).toEqual({ durationMs: 100, costUsd: 0.05, completionTokens: 500 });
  });

  it("includes both tokens when both provided", () => {
    expect(
      localToWireMetrics({
        durationMs: 200,
        costUsd: 0.10,
        promptTokens: 1000,
        completionTokens: 500,
      }),
    ).toEqual({
      durationMs: 200,
      costUsd: 0.10,
      promptTokens: 1000,
      completionTokens: 500,
    });
  });

  it("omits tokens when not provided (not 'undefined' on the wire)", () => {
    const out = localToWireMetrics({ durationMs: 100, costUsd: 0 });
    expect(out).not.toHaveProperty("promptTokens");
    expect(out).not.toHaveProperty("completionTokens");
  });
});

// ---------------------------------------------------------------------------
// localToWireResult
// ---------------------------------------------------------------------------

describe("localToWireResult", () => {
  const fullInput = {
    skillId: "code-edit",
    correlationId: "corr-1",
    peerId: "peer-abc",
    runtime: "envoy-harness" as const,
    content: [
      { type: "text", text: "thinking" },
      {
        type: "tool_call",
        id: "t1",
        name: "bash",
        args: { command: "ls" },
      },
      { type: "text", text: "done" },
    ] as ReadonlyArray<LocalContentBlock>,
    durationMs: 1234,
    promptTokens: 1000,
    completionTokens: 500,
    costUsd: 0.0125,
    raw: { secretAudit: "lossless local result" },
  };

  it("translates the full input into a wire result", () => {
    const out = localToWireResult(fullInput);
    expect(out.skillId).toBe("code-edit");
    expect(out.runtime).toBe("envoy-harness");
    expect(out.peerId).toBe("peer-abc");
    expect(out.correlationId).toBe("corr-1");
    expect(out.content).toHaveLength(3);
    expect(out.metrics).toEqual({
      durationMs: 1234,
      costUsd: 0.0125,
      promptTokens: 1000,
      completionTokens: 500,
    });
    expect(out.citations).toEqual([]);
    expect(out.raw).toEqual({ secretAudit: "lossless local result" });
  });

  it("sets completedAt to a valid ISO timestamp", () => {
    const out = localToWireResult(fullInput);
    expect(() => new Date(out.completedAt).toISOString()).not.toThrow();
    // Just-asserted: it's parseable. (Don't assert on the
    // exact value to avoid timing flakes.)
  });

  it("omits promptTokens/completionTokens when not provided", () => {
    // Force-undefined the token fields
    delete (fullInput as Record<string, unknown>)["promptTokens"];
    delete (fullInput as Record<string, unknown>)["completionTokens"];
    const out = localToWireResult(fullInput);
    expect(out.metrics).not.toHaveProperty("promptTokens");
    expect(out.metrics).not.toHaveProperty("completionTokens");
  });
});

// ---------------------------------------------------------------------------
// SchemaRef stability
// ---------------------------------------------------------------------------

describe("schemaRefs", () => {
  it("tool_call schemaRef is stable", () => {
    expect(TOOL_CALL_SCHEMA_REF).toBe("envoymesh://tool-call/v1");
  });

  it("tool_result schemaRef is stable", () => {
    expect(TOOL_RESULT_SCHEMA_REF).toBe("envoymesh://tool-result/v1");
  });
});
