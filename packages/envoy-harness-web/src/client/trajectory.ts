/**
 * Wave 4 — apply ACP session/activity tool events onto the transcript.
 */

import type { ActivityLike } from "./acp/activity.js";
import type { ChatMessage, ToolTrajectory } from "./acp/host-types.js";

export function findOpenToolIndex(
  messages: ReadonlyArray<ChatMessage>,
  activity: ActivityLike,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messages[i]?.tool;
    if (t === undefined) continue;
    if (t.phase === "result") continue;
    if (
      activity.toolCallId !== undefined &&
      t.toolCallId !== undefined &&
      t.toolCallId === activity.toolCallId
    ) {
      return i;
    }
    if (
      activity.toolName !== undefined &&
      t.toolName === activity.toolName
    ) {
      return i;
    }
    // Fall back to the most recent open tool card.
    return i;
  }
  return -1;
}

export function activityToToolMessage(
  activity: ActivityLike,
  id: string,
  at: number,
): ChatMessage | null {
  if (
    activity.kind !== "tool_call" &&
    activity.kind !== "tool_result" &&
    activity.kind !== "tool_progress"
  ) {
    return null;
  }
  const phase: ToolTrajectory["phase"] =
    activity.kind === "tool_call"
      ? "call"
      : activity.kind === "tool_result"
        ? "result"
        : "progress";
  const tool: ToolTrajectory = {
    phase,
    summary: activity.summary,
    ...(activity.toolName !== undefined ? { toolName: activity.toolName } : {}),
    ...(activity.toolCallId !== undefined
      ? { toolCallId: activity.toolCallId }
      : {}),
    ...(activity.toolArgs !== undefined ? { args: activity.toolArgs } : {}),
    ...(activity.resultPreview !== undefined
      ? { resultPreview: activity.resultPreview }
      : {}),
    ...(activity.images !== undefined && activity.images.length > 0
      ? { images: activity.images }
      : {}),
    ...(activity.isError === true ? { isError: true } : {}),
    ...(activity.durationMs !== undefined
      ? { durationMs: activity.durationMs }
      : {}),
    ...(phase === "progress" ? { progress: [activity.summary] } : {}),
  };
  return {
    id,
    role: "tool",
    text: activity.summary,
    at,
    tool,
    ...(activity.images !== undefined && activity.images.length > 0
      ? { images: activity.images }
      : {}),
  };
}

/**
 * Merge a tool activity into the message list.
 * - tool_call → append a new card
 * - tool_progress → append progress onto the open card (or new card)
 * - tool_result → close the open card (or append)
 */
export function applyToolActivity(
  messages: ReadonlyArray<ChatMessage>,
  activity: ActivityLike,
  nextId: () => string,
  now = Date.now(),
): ChatMessage[] {
  if (activity.kind === "tool_call") {
    const msg = activityToToolMessage(activity, nextId(), now);
    return msg === null ? [...messages] : [...messages, msg];
  }

  const idx = findOpenToolIndex(messages, activity);

  if (activity.kind === "tool_progress") {
    if (idx < 0) {
      const msg = activityToToolMessage(activity, nextId(), now);
      return msg === null ? [...messages] : [...messages, msg];
    }
    const prev = messages[idx]!;
    const tool = prev.tool!;
    const progress = [...(tool.progress ?? []), activity.summary].slice(-40);
    const next = [...messages];
    next[idx] = {
      ...prev,
      text: activity.summary,
      tool: {
        ...tool,
        phase: tool.phase === "result" ? tool.phase : "progress",
        summary: activity.summary,
        progress,
      },
    };
    return next;
  }

  if (activity.kind === "tool_result") {
    if (idx < 0) {
      const msg = activityToToolMessage(activity, nextId(), now);
      return msg === null ? [...messages] : [...messages, msg];
    }
    const prev = messages[idx]!;
    const tool = prev.tool!;
    const next = [...messages];
    next[idx] = {
      ...prev,
      text: activity.summary,
      tool: {
        ...tool,
        phase: "result",
        summary: activity.summary,
        ...(activity.toolName !== undefined
          ? { toolName: activity.toolName }
          : {}),
        ...(activity.toolCallId !== undefined
          ? { toolCallId: activity.toolCallId }
          : {}),
        ...(activity.resultPreview !== undefined
          ? { resultPreview: activity.resultPreview }
          : {}),
        ...(activity.images !== undefined && activity.images.length > 0
          ? { images: activity.images }
          : {}),
        ...(activity.isError === true
          ? { isError: true }
          : { isError: false }),
        ...(activity.durationMs !== undefined
          ? { durationMs: activity.durationMs }
          : {}),
      },
      ...(activity.images !== undefined && activity.images.length > 0
        ? { images: activity.images }
        : {}),
    };
    return next;
  }

  return [...messages];
}

/** True when this activity should become a tool card (not a status fold). */
export function isToolTrajectoryActivity(activity: ActivityLike): boolean {
  return (
    activity.kind === "tool_call" ||
    activity.kind === "tool_result" ||
    activity.kind === "tool_progress"
  );
}
