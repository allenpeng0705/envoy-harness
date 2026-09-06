/**
 * Lightweight activity line formatter (mirrors TUI activity.ts subset).
 */

export interface ActivityLike {
  kind: string;
  summary: string;
  ts?: string;
  subagentOf?: string;
  toolName?: string;
  isError?: boolean;
  durationMs?: number;
  costUsd?: number;
}

export function formatActivityLine(activity: ActivityLike): string {
  const prefix = activity.subagentOf !== undefined ? "  ↳ " : "";
  switch (activity.kind) {
    case "tool_call":
      return `${prefix}⏺ ${activity.summary}`;
    case "tool_result": {
      const ms =
        activity.durationMs !== undefined
          ? ` (${activity.durationMs}ms)`
          : "";
      const mark = activity.isError ? "✗" : "⎿";
      return `${prefix}  ${mark} ${activity.summary}${ms}`;
    }
    case "tool_progress":
      return `${prefix}  ⎿ ${activity.summary}`;
    case "agent_start":
      return activity.subagentOf !== undefined
        ? `${prefix}↳ ${activity.summary}`
        : activity.summary;
    case "agent_end":
      return activity.costUsd !== undefined
        ? `── turn · $${activity.costUsd.toFixed(4)} · ${activity.summary}`
        : `── ${activity.summary}`;
    case "error":
      return `✗ ${activity.summary}`;
    case "model_response":
      return "";
    default:
      return activity.summary;
  }
}
