/**
 * Map agent trace events to protocol activity records for TUI / hosts.
 */

import type { ToolCall } from "../tools/index.js";
import type { TraceEvent } from "../trace/types.js";
import type { ProtocolActivityEvent } from "./session-backend.js";

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function summarizeToolCall(call: ToolCall): string {
  const args = call.args as Record<string, unknown>;
  if (call.name === "task") {
    const objective =
      typeof args.objective === "string" ? args.objective : "";
    const runtime =
      typeof args.preferred_runtime === "string"
        ? args.preferred_runtime
        : typeof args.preferredRuntime === "string"
          ? args.preferredRuntime
          : "envoy-harness";
    const peerId =
      typeof args.preferred_peer_id === "string"
        ? args.preferred_peer_id
        : typeof args.preferredPeerId === "string"
          ? args.preferredPeerId
          : undefined;
    const peer = peerId !== undefined ? ` → peer ${peerId}` : "";
    const tag =
      typeof args.capability_tag === "string" && args.capability_tag.length > 0
        ? ` [${args.capability_tag}]`
        : "";
    return `spawn sub-agent (${runtime}${peer}${tag}) — ${truncate(objective, 72)}`;
  }
  if (call.name === "write" || call.name === "edit") {
    const path = typeof args.path === "string" ? args.path : "?";
    return `${call.name} ${path}`;
  }
  if (call.name === "bash") {
    const cmd = typeof args.command === "string" ? args.command : "";
    return `bash — ${truncate(cmd.replace(/\s+/g, " ").trim(), 64)}`;
  }
  if (call.name === "read_file") {
    const path = typeof args.path === "string" ? args.path : "?";
    return `read ${path}`;
  }
  try {
    return `${call.name}(${truncate(JSON.stringify(call.args), 56)})`;
  } catch {
    return call.name;
  }
}

function summarizeToolResult(
  toolName: string | undefined,
  content: string,
  isError: boolean,
): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) return isError ? "(error, empty)" : "(ok)";
  const head = truncate(trimmed.replace(/\s+/g, " "), 120);
  if (toolName === "write" || toolName === "edit") {
    return isError ? `failed — ${head}` : `updated — ${head}`;
  }
  return isError ? `error — ${head}` : head;
}

/** Convert one trace event to a wire-safe activity record. */
export function traceEventToActivity(event: TraceEvent): ProtocolActivityEvent {
  const base = {
    ts: event.ts,
    ...(event.subagentOf !== undefined ? { subagentOf: event.subagentOf } : {}),
  };
  switch (event.kind) {
    case "agent_start":
      return {
        ...base,
        kind: "agent_start",
        summary: event.subagentOf
          ? `sub-agent started (tools: ${event.tools.slice(0, 6).join(", ")}${event.tools.length > 6 ? "…" : ""})`
          : `agent started (${event.model})`,
        tools: [...event.tools],
      };
    case "model_response": {
      const textBlocks = event.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("");
      const preview =
        textBlocks.length > 0
          ? truncate(textBlocks.replace(/\s+/g, " ").trim(), 80)
          : "";
      const summary =
        preview.length > 0
          ? `${preview} (${event.stopReason})`
          : `model responded (${event.stopReason})`;
      return {
        ...base,
        kind: "model_response",
        summary,
        stopReason: event.stopReason,
      };
    }
    case "tool_call":
      return {
        ...base,
        kind: "tool_call",
        toolName: event.call.name,
        toolArgs: event.call.args,
        summary: summarizeToolCall(event.call),
      };
    case "tool_result": {
      const isError = event.result.isError === true;
      const text =
        typeof event.result.content === "string"
          ? event.result.content
          : String(event.result.content);
      return {
        ...base,
        kind: "tool_result",
        toolName: event.toolName,
        toolCallId: event.callId,
        isError,
        durationMs: event.durationMs,
        resultPreview: text,
        summary: summarizeToolResult(event.toolName, text, isError),
      };
    }
    case "agent_end":
      return {
        ...base,
        kind: "agent_end",
        summary: `done — ${event.iterations} model turns, ${event.toolCalls} tool calls, $${event.metrics.costUsd.toFixed(4)}`,
        iterations: event.iterations,
        toolCalls: event.toolCalls,
        costUsd: event.metrics.costUsd,
        stopReason: event.stopReason,
      };
    case "error":
      return {
        ...base,
        kind: "error",
        summary: `error — ${event.message}`,
        message: event.message,
      };
  }
}
