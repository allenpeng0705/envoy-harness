/**
 * Model-only user-role context (skill catalog, memory index, plan)
 * must not appear as human chat bubbles in EH / Social / EnvoyGo.
 */

import type { Message } from "../tools/types.js";

/** True when `text` is turn-context injection, not a human prompt. */
export function isEphemeralUserContextText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("<available_skills>")) return true;
  if (trimmed.startsWith("ACTIVE PLAN (approved at")) return true;
  if (trimmed.startsWith("Available memories (read with")) return true;
  if (trimmed.startsWith("[system] Your previous response")) return true;
  return false;
}

/** Skip model-only user messages when building chat transcripts. */
export function isEphemeralUserMessage(msg: Message): boolean {
  if (msg.role !== "user") return false;
  const text = msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return isEphemeralUserContextText(text);
}

/**
 * Append ephemeral turn context **after** this turn's user prompt.
 * Not persisted to the session.
 *
 * **Why "after" and not "before" — this is a prompt-cache fix.**
 * Inserting the block immediately *before* the trailing user message
 * changes the transcript at index 1 on every turn:
 *
 * ```
 * turn 1: [system, EPH1, user1, ...]
 * turn 2: [system, user1, asst1, ..., EPH2, user2, ...]
 * ```
 *
 * The longest common prefix between consecutive requests was therefore
 * the system prompt alone, so provider prefix caching (OpenAI ≥1024
 * token prefixes, DeepSeek automatic caching, Anthropic
 * `cache_control`) re-billed essentially the whole transcript on every
 * turn — the single largest avoidable cost in a long session.
 *
 * Appending instead keeps each request a **strict prefix-extension** of
 * its predecessor: everything the model already saw stays byte-identical,
 * and only the new turn's context plus the prompt are added. See
 * `test/context-prefix-stability.test.ts`, which asserts the property
 * directly.
 *
 * Trade-off: the block now sits after the human's message rather than
 * before it. Both are user-role, no transcript tooling depends on the
 * pair order, and the model reads the whole turn either way.
 */
export function injectEphemeralUserContext(
  messages: readonly Message[],
  ephemeralText: string,
): Message[] {
  if (ephemeralText.length === 0) return [...messages];
  const ephemeral: Message = {
    role: "user",
    content: [{ type: "text", text: ephemeralText }],
  };
  return [...messages, ephemeral];
}
