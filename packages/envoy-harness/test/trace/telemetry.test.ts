/**
 * Phase D / Item 17 — telemetry sink + invariants (hermetic).
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertRedactionInvariant,
  assertTraceEventShape,
  createJsonlTelemetrySink,
  createNullTelemetrySink,
  InvariantError,
} from "../../src/trace/index.js";
import type { TraceEvent } from "../../src/trace/types.js";

const toolCall: TraceEvent = {
  kind: "tool_call",
  ts: new Date().toISOString(),
  iteration: 1,
  call: { id: "c1", name: "job_start", args: {} },
};

const toolResult: TraceEvent = {
  kind: "tool_result",
  ts: new Date().toISOString(),
  iteration: 1,
  callId: "c1",
  result: { content: "ok" },
  durationMs: 12,
};

describe("telemetry", () => {
  it("null sink tracks counters", () => {
    const sink = createNullTelemetrySink();
    sink.emit({
      kind: "model_response",
      ts: new Date().toISOString(),
      iteration: 1,
      stopReason: "end_turn",
      content: [],
    });
    sink.emit(toolCall);
    sink.emit({
      kind: "error",
      ts: new Date().toISOString(),
      iteration: 1,
      message: "boom",
    });
    const c = sink.counters();
    expect(c.turns).toBe(1);
    expect(c.tools).toBe(1);
    expect(c.jobs).toBe(1);
    expect(c.errors).toBe(1);
  });

  it("jsonl sink writes events", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tel-"));
    const filePath = path.join(dir, "telemetry.jsonl");
    const sink = createJsonlTelemetrySink({ filePath });
    sink.emit(toolResult);
    await sink.flush?.();
    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain('"kind":"tool_result"');
    expect(raw).toContain('"callId":"c1"');
  });
});

describe("invariants", () => {
  it("assertTraceEventShape accepts valid tool_result", () => {
    expect(() => assertTraceEventShape(toolResult)).not.toThrow();
  });

  it("assertRedactionInvariant fails when secret leaks", () => {
    const leaked: TraceEvent = {
      kind: "error",
      ts: new Date().toISOString(),
      iteration: 0,
      message: "token=SUPER_SECRET_VALUE",
    };
    expect(() =>
      assertRedactionInvariant(leaked, { secrets: ["SUPER_SECRET_VALUE"] }),
    ).toThrow(InvariantError);
  });

  it("assertRedactionInvariant passes when clean", () => {
    expect(() =>
      assertRedactionInvariant(toolResult, { secrets: ["SUPER_SECRET_VALUE"] }),
    ).not.toThrow();
  });
});
