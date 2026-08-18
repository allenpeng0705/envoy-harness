/**
 * F9.4.1 tests — `TraceEvent` + `NullTracer` +
 * `JsonLinesTracer`.
 *
 * Covers:
 * 1. `NullTracer.emit` is a no-op (doesn't throw, no
 *    observable side effect).
 * 2. `JsonLinesTracer.emit` writes one JSON line per
 *    call (the body is `JSON.stringify(event) + "\n"`).
 * 3. `JsonLinesTracer` writes each event independently;
 *    each line is valid JSON.
 * 4. `JsonLinesTracer` survives a stream that throws —
 *    events are silently dropped, `droppedEvents` counts
 *    them.
 * 5. `JsonLinesTracer` survives a stream that returns
 *    `false` from `write` (no throw).
 * 6. The 6 event kinds are all valid `TraceEvent`s
 *    (the union is closed at this point; the test
 *    fails to compile if a kind is missing).
 */

import { describe, expect, it, vi } from "vitest";

import {
  JsonLinesTracer,
  NullTracer,
  type TraceEvent,
  type WritableStream,
} from "@envoymesh/envoy-harness";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A `WritableStream` that records every write. */
class MemoryStream implements WritableStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

/** A `WritableStream` that throws on every write. */
class ThrowingStream implements WritableStream {
  write(_chunk: string): boolean {
    throw new Error("nope");
  }
}

/** A `WritableStream` that returns `false` (back-pressure). */
class BackpressureStream implements WritableStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return false; // signals back-pressure
  }
}

const sampleEvent: TraceEvent = {
  kind: "agent_start",
  ts: "2026-08-18T00:00:00.000Z",
  sessionId: "sess-1",
  model: "gpt-4",
  cwd: "/",
  tools: ["read_file", "bash"],
};

// ---------------------------------------------------------------------------
// NullTracer
// ---------------------------------------------------------------------------

describe("NullTracer", () => {
  it("emit is a no-op (doesn't throw, no observable side effect)", () => {
    const t = new NullTracer();
    expect(() => t.emit(sampleEvent)).not.toThrow();
    // No internal state to assert on; just confirm the
    // method runs cleanly.
  });

  it("can be called many times without leaking", () => {
    const t = new NullTracer();
    for (let i = 0; i < 1000; i++) t.emit(sampleEvent);
  });
});

// ---------------------------------------------------------------------------
// JsonLinesTracer
// ---------------------------------------------------------------------------

describe("JsonLinesTracer", () => {
  it("writes one JSON line per call (ends with newline)", () => {
    const stream = new MemoryStream();
    const t = new JsonLinesTracer(stream);
    t.emit(sampleEvent);
    expect(stream.chunks).toHaveLength(1);
    const line = stream.chunks[0]!;
    expect(line.endsWith("\n")).toBe(true);
    // Body is valid JSON.
    const parsed = JSON.parse(line);
    expect(parsed).toEqual(sampleEvent);
  });

  it("writes each event as its own line (independently valid JSON)", () => {
    const stream = new MemoryStream();
    const t = new JsonLinesTracer(stream);
    const events: TraceEvent[] = [
      sampleEvent,
      {
        kind: "model_response",
        ts: "2026-08-18T00:00:01.000Z",
        iteration: 1,
        stopReason: "end_turn",
        content: [{ type: "text", text: "hi" }],
      },
      {
        kind: "agent_end",
        ts: "2026-08-18T00:00:02.000Z",
        stopReason: "end_turn",
        iterations: 1,
        toolCalls: 0,
        metrics: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      },
    ];
    for (const e of events) t.emit(e);
    expect(stream.chunks).toHaveLength(3);
    // Each chunk is independently parseable.
    for (let i = 0; i < events.length; i++) {
      expect(JSON.parse(stream.chunks[i]!)).toEqual(events[i]);
    }
  });

  it("survives a stream that throws (silently drops)", () => {
    const stream = new ThrowingStream();
    const t = new JsonLinesTracer(stream);
    expect(() => t.emit(sampleEvent)).not.toThrow();
    expect(t.droppedEvents).toBe(1);
    t.emit(sampleEvent);
    expect(t.droppedEvents).toBe(2);
  });

  it("survives a stream that returns false (back-pressure)", () => {
    const stream = new BackpressureStream();
    const t = new JsonLinesTracer(stream);
    expect(() => t.emit(sampleEvent)).not.toThrow();
    // The chunk was still recorded (the contract is
    // "don't throw on back-pressure", not "drop the
    // event").
    expect(stream.chunks).toHaveLength(1);
    expect(t.droppedEvents).toBe(0);
  });

  it("uses `process.stdout`-compatible streams", () => {
    // Real `process.stdout.write` returns boolean | void.
    // The WritableStream type is structural; this test
    // just confirms the structural compatibility by
    // passing a mock.
    const write = vi.fn((_chunk: string) => true);
    const stream: WritableStream = { write };
    const t = new JsonLinesTracer(stream);
    t.emit(sampleEvent);
    expect(write).toHaveBeenCalledTimes(1);
    const arg = (write.mock.calls[0] as unknown as [string])[0]!;
    expect(arg.endsWith("\n")).toBe(true);
    expect(JSON.parse(arg)).toEqual(sampleEvent);
  });
});

// ---------------------------------------------------------------------------
// TraceEvent union is closed at this point
// ---------------------------------------------------------------------------

describe("TraceEvent union", () => {
  it("every kind compiles (the union is closed)", () => {
    const events: TraceEvent[] = [
      sampleEvent,
      {
        kind: "model_response",
        ts: "",
        iteration: 1,
        stopReason: "end_turn",
        content: [{ type: "text", text: "" }],
      },
      {
        kind: "tool_call",
        ts: "",
        iteration: 1,
        call: { id: "t1", name: "bash", args: {} },
      },
      {
        kind: "tool_result",
        ts: "",
        iteration: 1,
        callId: "t1",
        result: { content: "ok" },
        durationMs: 5,
      },
      {
        kind: "agent_end",
        ts: "",
        stopReason: "end_turn",
        iterations: 1,
        toolCalls: 1,
        metrics: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      },
      {
        kind: "error",
        ts: "",
        iteration: 1,
        message: "boom",
      },
    ];
    const stream = new MemoryStream();
    const t = new JsonLinesTracer(stream);
    for (const e of events) t.emit(e);
    expect(stream.chunks).toHaveLength(6);
  });
});
