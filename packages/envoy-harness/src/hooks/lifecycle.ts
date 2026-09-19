/**
 * Lifecycle hook payloads and fire helpers.
 *
 * **Why this module exists.** The `HookEventName` union declares **12**
 * events, but only `PreToolUse` and `PostToolUse` had fire sites. The
 * other ten were declared types, accepted by the config loader and by
 * the codex/Claude-Code config importers, and **never fired** — so a
 * user who configured a `SessionStart` or `PreCompact` hook (exactly what
 * a codex or Claude Code user would expect to work) got silence.
 *
 * This module defines each payload shape once and provides typed
 * `fire*` helpers, so a boundary calls one function and the wire shape
 * lives in a single place.
 *
 * **Decision handling by event** (per the design's §8.1 contract):
 *
 * | Event | honored decisions |
 * |---|---|
 * | `Setup`, `SessionStart`, `PreCompact` | `add-context`, `block` (PreCompact) |
 * | `UserPromptSubmit` | `block` |
 * | `PermissionRequest` | `block` |
 * | `Stop`, `SessionEnd`, `PostCompact`, `SubagentStop`, `Notification` | observer (any decision ignored) |
 */

import type { HookDecision, HookEventName } from "../types.js";

/**
 * The narrowest hook seam: anything that can fire an event and return a
 * decision. `HookRegistry` satisfies it, and so does the executor's
 * partial context — which only declared two events before, so the other
 * ten could not have been fired from there at all.
 */
export interface HookFirer {
  fire(event: HookEventName, payload: unknown): Promise<HookDecision>;
}

/**
 * Marker prefix for text a hook contributed via `add-context`.
 *
 * Chat hosts already hide model-only user-role context; using the same
 * channel keeps a hook's injected text out of the human transcript while
 * still making it **durable** (it is part of the session log), which is
 * what a hook that injects project rules actually wants.
 */
export const HOOK_CONTEXT_PREFIX = "[hook-context:";

/** Render `add-context` content for injection as a user-role message. */
export function renderHookContext(event: string, content: string): string {
  return `${HOOK_CONTEXT_PREFIX}${event}]\n${content}`;
}

/** True when `text` came from a hook's `add-context` decision. */
export function isHookContextText(text: string): boolean {
  return text.trimStart().startsWith(HOOK_CONTEXT_PREFIX);
}

export interface SetupPayload {
  readonly cwd: string;
  readonly sessionId?: string;
}
export interface SessionStartPayload {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model?: string;
}
export interface SessionEndPayload {
  readonly sessionId: string;
  readonly reason: string;
  readonly messages: number;
}
export interface UserPromptSubmitPayload {
  readonly sessionId: string;
  /** The prompt text, as submitted. */
  readonly prompt: string;
}
export interface StopPayload {
  readonly sessionId: string;
  readonly stopReason: string;
  readonly iterations: number;
}
export interface SubagentStopPayload {
  readonly parentSessionId?: string;
  readonly workerPeerId: string;
  readonly status: string;
}
export interface PreCompactPayload {
  readonly sessionId: string;
  readonly keep: number;
  readonly messagesBefore: number;
  readonly droppedCount: number;
}
export interface PostCompactPayload {
  readonly sessionId: string;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
  readonly droppedCount: number;
  readonly summarized: boolean;
}
export interface PermissionRequestPayload {
  readonly sessionId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly question: string;
}
export interface NotificationPayload {
  readonly sessionId: string;
  /** `permission_request` | `idle` | … — free-form, host-defined. */
  readonly kind: string;
  readonly message: string;
}

/**
 * Fire an observer event, swallowing nothing: a hook failure is already
 * converted to a `block` decision by the registry, and for an observer
 * event there is nothing to block — so we deliberately ignore the
 * decision but still let the registry run the handlers.
 */
async function fireObserver(
  hooks: HookFirer | undefined,
  name: HookEventName,
  payload: unknown,
): Promise<void> {
  if (hooks === undefined) return;
  await hooks.fire(name, payload);
}

/**
 * Fire a lifecycle event whose `add-context` output the caller should
 * inject. Returns the collected context (empty when none/blocked).
 */
export async function fireContextHook(
  hooks: HookFirer | undefined,
  name: "Setup" | "SessionStart",
  payload: SetupPayload | SessionStartPayload,
): Promise<{ context: string; blocked: string | undefined }> {
  if (hooks === undefined) return { context: "", blocked: undefined };
  const decision = await hooks.fire(name, payload);
  if (decision.kind === "block") {
    return { context: "", blocked: decision.reason };
  }
  if (decision.kind === "add-context") {
    return { context: renderHookContext(name, decision.content), blocked: undefined };
  }
  return { context: "", blocked: undefined };
}

/** Fire `UserPromptSubmit`; a `block` cancels the turn before the model. */
export async function fireUserPromptSubmit(
  hooks: HookFirer | undefined,
  payload: UserPromptSubmitPayload,
): Promise<{ blocked: string | undefined }> {
  if (hooks === undefined) return { blocked: undefined };
  const decision = await hooks.fire("UserPromptSubmit", payload);
  return decision.kind === "block" ? { blocked: decision.reason } : { blocked: undefined };
}

/**
 * Fire `PermissionRequest`, which can veto before the human is asked.
 *
 * `block` means "deny outright" — a hook that knows the action is
 * forbidden should not put the question to a human at all.
 */
export async function firePermissionRequest(
  hooks: HookFirer | undefined,
  payload: PermissionRequestPayload,
): Promise<{ blocked: string | undefined }> {
  if (hooks === undefined) return { blocked: undefined };
  const decision = await hooks.fire("PermissionRequest", payload);
  return decision.kind === "block" ? { blocked: decision.reason } : { blocked: undefined };
}

/** Fire `PreCompact`. `block` refuses the compaction entirely. */
export async function firePreCompact(
  hooks: HookFirer | undefined,
  payload: PreCompactPayload,
): Promise<{ blocked: string | undefined; context: string }> {
  if (hooks === undefined) return { blocked: undefined, context: "" };
  const decision = await hooks.fire("PreCompact", payload);
  if (decision.kind === "block") {
    return { blocked: decision.reason, context: "" };
  }
  return {
    blocked: undefined,
    context:
      decision.kind === "add-context"
        ? renderHookContext("PreCompact", decision.content)
        : "",
  };
}

export const firePostCompact = (
  hooks: HookFirer | undefined,
  payload: PostCompactPayload,
): Promise<void> => fireObserver(hooks, "PostCompact", payload);

export const fireStop = (
  hooks: HookFirer | undefined,
  payload: StopPayload,
): Promise<void> => fireObserver(hooks, "Stop", payload);

export const fireSubagentStop = (
  hooks: HookFirer | undefined,
  payload: SubagentStopPayload,
): Promise<void> => fireObserver(hooks, "SubagentStop", payload);

export const fireSessionStart = (
  hooks: HookFirer | undefined,
  payload: SessionStartPayload,
): Promise<{ context: string; blocked: string | undefined }> =>
  fireContextHook(hooks, "SessionStart", payload);

export const fireSetup = (
  hooks: HookFirer | undefined,
  payload: SetupPayload,
): Promise<{ context: string; blocked: string | undefined }> =>
  fireContextHook(hooks, "Setup", payload);

export const fireSessionEnd = (
  hooks: HookFirer | undefined,
  payload: SessionEndPayload,
): Promise<void> => fireObserver(hooks, "SessionEnd", payload);

export const fireNotification = (
  hooks: HookFirer | undefined,
  payload: NotificationPayload,
): Promise<void> => fireObserver(hooks, "Notification", payload);

/** Re-export for callers that only need the decision type. */
export type { HookDecision };
