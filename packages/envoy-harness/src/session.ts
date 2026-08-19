/**
 * Session — the transcript + (eventually) the persistence layer.
 *
 * **Design doc:** `docs/design.md` §3.2 (session lifecycle).
 *
 * **Phase 1 scope:** in-memory only. The session holds the
 * running transcript (a list of `Message`s) and a few metadata
 * fields. Persistence (writing to disk, projecting to other
 * formats) lands in Phase 2.
 *
 * **Why a class and not a plain object?** The class enforces
 * invariants: `id` is read-only, `messages` is append-only via
 * `appendMessage`, and the transcript never goes backward.
 * Plain objects can't enforce those rules without runtime checks
 * scattered through the code.
 *
 * **`appendMessage` is the only mutation.** The agent calls it
 * after every model response and every tool result. The session
 * is the source of truth for "what has happened so far" in
 * the loop.
 *
 * **Stability:** `id`, `messages`, `appendMessage`, `lastMessage`,
 * `clear` are the public API. Adding fields is additive.
 */

import type { ContentBlock, Message, Role } from "./tools/types.js";

/** Optional metadata about a session. */
export interface SessionMetadata {
  /** User-visible label (e.g. the first 60 chars of the prompt). */
  title?: string;
  /** Working directory for tool execution. */
  cwd: string;
  /** Permission mode at session start. */
  permissionMode?: "read-only" | "workspace-write" | "danger-full-access";
  /** ISO timestamp of session start. */
  startedAt: string;
}

export interface Session {
  /** Unique session id. Stable across the session's lifetime. */
  readonly id: string;
  /** Session metadata. */
  readonly metadata: SessionMetadata;
  /**
   * Read-only view of the transcript. The agent never mutates
   * this directly — it calls `appendMessage`. Exposed as
   * readonly so callers can't bypass the append-only invariant.
   */
  readonly messages: ReadonlyArray<Message>;
  /**
   * Append a message to the transcript. This is the only
   * mutation. Returns the new length so callers can sanity-check.
   *
   * `content` defaults to `[]` for system messages; callers can
   * pass an explicit array for assistant messages with text +
   * tool calls.
   */
  appendMessage(
    role: Role,
    content: ReadonlyArray<ContentBlock>,
  ): number;
  /** The most recent message, or `null` if the transcript is empty. */
  lastMessage(): Message | null;
  /** Remove all messages. Test-only utility. */
  clear(): void;
  /**
   * F14.1: update the session's display title. The
   * `metadata.title` field is the user-facing label
   * (e.g. shown by the REPL's `/session` command and
   * persisted to disk in F14's persisted session).
   *
   * **Why a setter, not a direct field write:** the
   * `metadata` field is `readonly` (the object
   * reference can't change), but the OBJECT's
   * properties are mutable. A dedicated method
   * documents the intent and lets `PersistedSession`
   * (F14) also write through to disk in the same call.
   *
   * **Add-on:** implementations that don't persist
   * (like the in-memory one) can just mutate
   * `metadata.title`. `PersistedSession` does the
   * same + flushes the header line.
   */
  setTitle(title: string): void;
}

/**
 * In-memory session. The default implementation for v0. Phase 2
 * adds a `PersistedSession` that writes through to disk; the
 * `Session` interface stays the same.
 *
 * **Id generation:** `randomUUID()` is fine for v0 (we don't
 * need deterministic ids yet). Phase 2 may swap to a content-
 * hash-based id for reproducibility.
 */
export class InMemorySession implements Session {
  readonly id: string;
  readonly metadata: SessionMetadata;
  private _messages: Message[] = [];

  constructor(id: string, metadata: SessionMetadata) {
    this.id = id;
    this.metadata = metadata;
  }

  get messages(): ReadonlyArray<Message> {
    return this._messages;
  }

  appendMessage(
    role: Role,
    content: ReadonlyArray<ContentBlock>,
  ): number {
    this._messages.push({ role, content: [...content] });
    return this._messages.length;
  }

  lastMessage(): Message | null {
    return this._messages[this._messages.length - 1] ?? null;
  }

  clear(): void {
    this._messages = [];
  }

  /**
   * F14.1: set the session's display title. The
   * `metadata.title` field is mutable (the object
   * reference is `readonly` on the class field, but
   * the object's properties are not). Just assign
   * — no side effects (the in-memory session doesn't
   * persist; the persisted one does, separately).
   */
  setTitle(title: string): void {
    this.metadata.title = title;
  }
}

/**
 * Generate a new session id. Uses `crypto.randomUUID()` for
 * v0; deterministic ids can be added in a later chunk if needed
 * for replay / snapshot tests.
 */
export function newSessionId(): string {
  // crypto.randomUUID is available in Node 19+ and all modern browsers.
  return globalThis.crypto.randomUUID();
}
