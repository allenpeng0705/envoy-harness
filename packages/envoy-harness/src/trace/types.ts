/**
 * Trace types (§19 of the design — F9.4 Phase 4 feature).
 *
 * **What is this module?** the public type surface for the
 * trace observability layer. The agent emits a stream of
 * `TraceEvent`s at key points; a `Tracer` implementation
 * decides what to do with them (the CLI's `--json` flag
 * wires a `JsonLinesTracer` to stdout).
 *
 * **Why a discriminated union:** each event kind has a
 * different shape (agent_start has sessionId + tools;
 * tool_result has durationMs + result). A union forces
 * the consumer to handle each kind explicitly; the
 * `kind` field is the discriminator.
 *
 * **`ts` field:** every event carries an ISO 8601
 * timestamp. We use `new Date().toISOString()` rather
 * than `process.hrtime` so the trace is human-readable.
 * Sub-millisecond ordering is not part of the contract.
 *
 * **What this is NOT:**
 * - Not a logging system. The `Logger` field on
 *   `StdioLspClient` is for internal diagnostics; the
 *   trace is for user-observable events.
 * - Not a metrics system. Token counts and cost are
 *   included in `agent_end` but not every event.
 *   v0 doesn't ship histograms; that's downstream.
 *
 * **Stability:** additive. New event kinds are added
 * over time. Consumers should switch on `kind` and
 * have a default branch (forward-compat).
 */

import type { ModelResponse } from "../model.js";
import type { Usage } from "../cost.js";
import type { AgentResult } from "../agent.js";
import type { ToolCall, ToolResult } from "../tools/index.js";

/** Common fields on every event. */
interface TraceBase {
  /** ISO 8601 timestamp. */
  ts: string;
}

/** Emitted once at the start of `Agent.run()`. */
export interface AgentStartEvent extends TraceBase {
  kind: "agent_start";
  sessionId: string;
  /** The model name (e.g. "gpt-4", "claude-3-5-sonnet"). */
  model: string;
  /** The agent's working directory. */
  cwd: string;
  /** Names of the tools the model can call. */
  tools: ReadonlyArray<string>;
}

/** Emitted after every model response (before tool execution). */
export interface ModelResponseEvent extends TraceBase {
  kind: "model_response";
  /** 1-indexed iteration number. */
  iteration: number;
  stopReason: ModelResponse["stopReason"];
  content: ModelResponse["content"];
  /** Optional usage (when the adapter reports it). */
  usage?: Usage;
}

/** Emitted after a tool call passes the PreToolUse hook
 *  (i.e. right before the tool's `execute` runs). */
export interface ToolCallEvent extends TraceBase {
  kind: "tool_call";
  iteration: number;
  call: ToolCall;
}

/** Emitted after a tool's `execute` returns. */
export interface ToolResultEvent extends TraceBase {
  kind: "tool_result";
  iteration: number;
  /** The tool call id this is a result for. */
  callId: string;
  result: ToolResult;
  durationMs: number;
}

/** Emitted once at the end of `Agent.run()` (any reason). */
export interface AgentEndEvent extends TraceBase {
  kind: "agent_end";
  stopReason: AgentResult["stopReason"];
  iterations: number;
  toolCalls: number;
  metrics: AgentResult["metrics"];
}

/** Emitted when the agent loop catches an error. */
export interface ErrorEvent extends TraceBase {
  kind: "error";
  /** The iteration that errored (or -1 for errors before the loop). */
  iteration: number;
  message: string;
}

/** The full event union. */
export type TraceEvent =
  | AgentStartEvent
  | ModelResponseEvent
  | ToolCallEvent
  | ToolResultEvent
  | AgentEndEvent
  | ErrorEvent;

/**
 * A consumer of trace events. The agent calls
 * `emit(event)` at 5 points; the implementation
 * decides what to do (no-op, write to stdout, ship
 * to a logging service, etc.).
 *
 * **Synchronous contract:** `emit` is sync. The agent
 * does not await. Implementations that need to do
 * async I/O must buffer (or fire-and-forget).
 */
export interface Tracer {
  emit(event: TraceEvent): void;
}
