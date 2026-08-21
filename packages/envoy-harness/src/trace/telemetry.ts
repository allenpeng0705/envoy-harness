/**
 * Phase D / Item 17 — telemetry sink over {@link Tracer}.
 *
 * Counters for turn / tool / job events; JSONL and null
 * sink factories for hermetic tests and CLI hosts.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { TraceEvent, Tracer } from "./types.js";

/** Counters maintained by a {@link TelemetrySink}. */
export interface TelemetryCounters {
  turns: number;
  tools: number;
  jobs: number;
  errors: number;
}

export interface TelemetrySink extends Tracer {
  /** Snapshot of counters (copy). */
  counters(): TelemetryCounters;
  /** Optional flush for buffered sinks. */
  flush?(): Promise<void>;
}

export interface JsonlTelemetrySinkOptions {
  /** Path to append JSONL events. */
  filePath: string;
  /** Optional inner tracer (fan-out). */
  inner?: Tracer;
}

function emptyCounters(): TelemetryCounters {
  return { turns: 0, tools: 0, jobs: 0, errors: 0 };
}

function bump(counters: TelemetryCounters, event: TraceEvent): void {
  switch (event.kind) {
    case "model_response":
      counters.turns += 1;
      break;
    case "tool_call":
      counters.tools += 1;
      if (event.call.name.startsWith("job_")) {
        counters.jobs += 1;
      }
      break;
    case "error":
      counters.errors += 1;
      break;
    default:
      break;
  }
}

/** No-op sink that still tracks counters. */
export function createNullTelemetrySink(): TelemetrySink {
  const counters = emptyCounters();
  return {
    emit(event) {
      bump(counters, event);
    },
    counters() {
      return { ...counters };
    },
  };
}

/**
 * Append-only JSONL telemetry sink. `emit` is sync
 * (fire-and-forget writes); call {@link TelemetrySink.flush}
 * before process exit.
 */
export function createJsonlTelemetrySink(
  options: JsonlTelemetrySinkOptions,
): TelemetrySink {
  const counters = emptyCounters();
  let chain: Promise<void> = Promise.resolve();
  const dir = path.dirname(options.filePath);

  return {
    emit(event) {
      bump(counters, event);
      options.inner?.emit(event);
      const line = JSON.stringify(event) + "\n";
      chain = chain
        .then(async () => {
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(options.filePath, line, {
            encoding: "utf8",
            flag: "a",
          });
        })
        .catch(() => undefined);
    },
    counters() {
      return { ...counters };
    },
    async flush() {
      await chain;
    },
  };
}

/** Wrap an existing tracer with counters. */
export function wrapTracerAsTelemetrySink(inner: Tracer): TelemetrySink {
  const counters = emptyCounters();
  return {
    emit(event) {
      bump(counters, event);
      inner.emit(event);
    },
    counters() {
      return { ...counters };
    },
  };
}
