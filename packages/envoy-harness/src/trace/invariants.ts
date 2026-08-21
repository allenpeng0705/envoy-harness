/**
 * Phase D / Item 17 — lightweight invariant checks for
 * traces / telemetry (dev-time contract assertions).
 */

import type { TraceEvent } from "./types.js";

export type InvariantKind = "redaction" | "shape";

export class InvariantError extends Error {
  override readonly name = "InvariantError";
  constructor(
    message: string,
    readonly kind: InvariantKind,
  ) {
    super(message);
  }
}

export interface RedactionInvariantOptions {
  /** Secret substrings that must not appear in serialized events. */
  secrets: readonly string[];
}

/**
 * Assert that none of `secrets` appear in the JSON
 * serialization of `event`. Throws {@link InvariantError}
 * on failure.
 */
export function assertRedactionInvariant(
  event: TraceEvent,
  options: RedactionInvariantOptions,
): void {
  const serialized = JSON.stringify(event);
  for (const secret of options.secrets) {
    if (secret.length === 0) continue;
    if (serialized.includes(secret)) {
      throw new InvariantError(
        `secret leaked into trace event kind=${event.kind}`,
        "redaction",
      );
    }
  }
}

/**
 * Basic shape check: every event must have `kind` + `ts`.
 */
export function assertTraceEventShape(event: TraceEvent): void {
  if (typeof event.kind !== "string" || event.kind.length === 0) {
    throw new InvariantError("trace event missing kind", "shape");
  }
  if (typeof event.ts !== "string" || event.ts.length === 0) {
    throw new InvariantError("trace event missing ts", "shape");
  }
  if (event.kind === "tool_result") {
    if (typeof event.callId !== "string") {
      throw new InvariantError("tool_result missing callId", "shape");
    }
    if (typeof event.durationMs !== "number") {
      throw new InvariantError("tool_result missing durationMs", "shape");
    }
  }
}
