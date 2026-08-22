/**
 * Phase D / Item 17 — telemetry sink + invariants (hermetic).
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("jsonl sink bumps `dropped` and invokes onDropped when writes fail (regression)", async () => {
    // Before the fix, every write error was swallowed in
    // `.catch(() => undefined)` and there was no way to
    // know events were being lost. The sink now counts
    // drops and surfaces them via the callback.
    //
    // To force a write failure, we point the sink at a
    // path where the parent component is a regular FILE
    // (not a directory). `mkdir(parent, recursive)` will
    // happily no-op (the parent already exists), and
    // `writeFile` will fail with ENOTDIR / EISDIR.
    const dir = await mkdtemp(path.join(tmpdir(), "tel-"));
    // Create a regular file that we'll use as a "parent
    // directory" for the bad path.
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "I am a file, not a dir");
    const badPath = path.join(blocker, "fail.jsonl");

    const seen: unknown[] = [];
    const sink = createJsonlTelemetrySink({
      filePath: badPath,
      onDropped: (err) => {
        seen.push(err);
      },
    });
    sink.emit(toolCall);
    await sink.flush?.();
    expect(sink.counters().dropped).toBeGreaterThanOrEqual(1);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    // Event was still counted as a tool (the inner bump runs
    // before the file write, so counters reflect intent).
    expect(sink.counters().tools).toBe(1);
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
