/**
 * Format protocol activity events for the TUI transcript (Codex / Claude Code style).
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

/** One transcript line body for a live activity event. */
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
      return formatTurnEndCard(activity);
    case "model_response":
      return `… ${activity.summary}`;
    case "error":
      return `✗ ${activity.summary}`;
    default:
      return activity.summary;
  }
}

/** Multi-line turn summary card (Codex / Claude Code end-of-turn). */
export function formatTurnEndCard(activity: ActivityLike): string {
  const lines = ["── Turn complete ──", `✓ ${activity.summary}`];
  if (activity.costUsd !== undefined) {
    lines.push(`  cost: $${activity.costUsd.toFixed(4)}`);
  }
  return lines.join("\n");
}
