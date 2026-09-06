/**
 * ACP streaming, activity, and protocol message handlers.
 */

import type { ActivityLike } from "./activity.js";
import { formatActivityLine } from "./activity.js";
import type { PushFn, SessionProtocolState } from "./session-context.js";
import type { TranscriptRole } from "./transcript.js";

/** Drop or finalize the in-flight assistant stream line on cancel. */
export function clearStreamingAssistantImpl(
  state: SessionProtocolState,
): void {
  if (state.streamingAssistantLineIndex === undefined) {
    state.streamingAssistantText = "";
    return;
  }
  const line = state.lines[state.streamingAssistantLineIndex];
  if (line === undefined) {
    state.streamingAssistantText = "";
    state.streamingAssistantLineIndex = undefined;
    return;
  }
  line.text =
    line.text.length > 0 ? `${line.text} [cancelled]` : "(cancelled)";
  state.streamingAssistantText = "";
  state.streamingAssistantLineIndex = undefined;
  state.onTranscript?.(state.lines);
}

export function handleSessionActivityImpl(
  state: SessionProtocolState,
  params: unknown,
  pushActivity: (activity: ActivityLike) => void,
): void {
  if (!state.busy || state.sessionId === undefined) return;
  const p = params as {
    sessionId?: string;
    activity?: ActivityLike;
  };
  if (p.sessionId !== undefined && p.sessionId !== state.sessionId) return;
  if (p.activity !== undefined) {
    pushActivity(p.activity);
  }
}

export function pushActivityImpl(
  state: SessionProtocolState,
  push: PushFn,
  activity: ActivityLike,
): void {
  if (activity.kind === "agent_end") {
    collapseTurnActivityLinesImpl(state);
  }
  if (activity.kind === "model_response") return;
  if (activity.kind === "tool_result" && activity.isError !== true) return;
  if (activity.kind === "agent_start") return;

  const key =
    activity.kind === "tool_progress"
      ? `${activity.kind}\0${activity.ts ?? ""}\0${activity.summary}`
      : `${activity.kind}\0${activity.summary}\0${activity.ts ?? ""}`;
  if (state.turnSeen.has(key)) return;
  state.turnSeen.add(key);
  if (
    activity.kind === "tool_call" ||
    activity.kind === "tool_result" ||
    activity.kind === "tool_progress"
  ) {
    state.turnToolActivityLines++;
    state.turnActivityLineIndices.push(state.lines.length);
  }
  if (activity.kind === "agent_end" && activity.costUsd !== undefined) {
    state.lastTurnCostUsd = activity.costUsd;
  }
  push("status", formatActivityLine(activity));
}

export function collapseTurnActivityLinesImpl(
  state: SessionProtocolState,
): void {
  if (state.turnActivityLineIndices.length === 0) return;
  const sorted = [...state.turnActivityLineIndices].sort((a, b) => b - a);
  for (const idx of sorted) {
    state.lines.splice(idx, 1);
    if (
      state.streamingAssistantLineIndex !== undefined &&
      idx < state.streamingAssistantLineIndex
    ) {
      state.streamingAssistantLineIndex -= 1;
    }
  }
  state.turnActivityLineIndices.length = 0;
  state.turnToolActivityLines = 0;
  state.onTranscript?.(state.lines);
}

export function handleSessionTokenImpl(
  state: SessionProtocolState,
  params: unknown,
): void {
  if (!state.busy || state.sessionId === undefined) return;
  const p = params as {
    sessionId?: string;
    token?: { role?: string; delta?: string };
  };
  if (p.sessionId !== undefined && p.sessionId !== state.sessionId) return;
  const token = p.token;
  if (token === undefined) return;
  if (
    token.role !== "assistant" ||
    typeof token.delta !== "string" ||
    token.delta.length === 0
  ) {
    return;
  }
  state.streamingAssistantText += token.delta;
  if (state.streamingAssistantLineIndex === undefined) {
    state.lines.push({
      role: "assistant",
      text: state.streamingAssistantText,
      at: new Date().toISOString(),
    });
    state.streamingAssistantLineIndex = state.lines.length - 1;
  } else {
    const streamLine = state.lines[state.streamingAssistantLineIndex];
    if (streamLine !== undefined) {
      streamLine.text = state.streamingAssistantText;
    }
  }
  state.onTranscript?.(state.lines);
}

export function handleSessionUpdateImpl(
  state: SessionProtocolState,
  params: unknown,
  consumeMessage: (msg: unknown) => void,
): void {
  if (!state.busy || state.sessionId === undefined) return;
  const p = params as {
    sessionId?: string;
    message?: { role?: string; text?: string };
  };
  if (p.sessionId !== undefined && p.sessionId !== state.sessionId) return;
  consumeMessage(p.message);
}

export function consumeProtocolMessageImpl(
  state: SessionProtocolState,
  push: PushFn,
  msg: unknown,
): void {
  if (msg === undefined || msg === null) return;
  const m = msg as { role?: string; text?: string };
  if (typeof m.text !== "string" || m.text.length === 0) return;
  const rawRole = (m.role as TranscriptRole | undefined) ?? "assistant";
  if (rawRole === "user" || rawRole === "system" || rawRole === "status") {
    return;
  }
  const role: TranscriptRole =
    rawRole === "assistant" || rawRole === "tool" ? rawRole : "assistant";
  if (
    role === "assistant" &&
    state.streamingAssistantLineIndex !== undefined
  ) {
    const streamLine = state.lines[state.streamingAssistantLineIndex];
    if (streamLine !== undefined) {
      streamLine.text = m.text;
    }
    state.turnSeen.add(`${role}\0${m.text}`);
    state.streamingAssistantLineIndex = undefined;
    state.streamingAssistantText = "";
    state.onTranscript?.(state.lines);
    return;
  }
  if (
    role === "tool" &&
    state.busy &&
    state.turnToolActivityLines > 0
  ) {
    return;
  }
  const key = `${role}\0${m.text}`;
  if (state.turnSeen.has(key)) return;
  state.turnSeen.add(key);
  push(role, m.text);
}
