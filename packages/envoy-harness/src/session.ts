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

/**
 * Kinds of durable diagnostic record.
 *
 * Deliberately a closed vocabulary: a resumed session, a UI, or a
 * post-mortem script can switch on these without parsing prose.
 */
export type SessionDiagnosticKind =
  /** A transient model failure was retried. */
  | "retry"
  /** Retries were refused, exhausted, or the server asked for too long. */
  | "retry-exhausted"
  /** Retrying was abandoned because the turn was cancelled. */
  | "retry-abandoned"
  /** The OS sandbox blocked an operation. */
  | "sandbox-denied"
  /** A denial was escalated and the user widened the policy. */
  | "sandbox-escalated"
  /** A denial was escalated and the user (or policy) refused. */
  | "sandbox-escalation-denied";

/**
 * A bounded, durable record of something that happened *to* the session
 * rather than *in* it.
 *
 * **Why durable, and why not a transcript message.** The transcript is the
 * conversation the model sees; injecting synthetic messages for retries
 * would break prompt-cache prefix stability and the transcript
 * invariants. But a session that survived a rate-limit storm should be
 * able to say so after `--resume` — otherwise the only evidence is a trace
 * stream that is disabled by default (`NullTracer`). These records ride in
 * the session header, which is already rewritten atomically.
 */
export interface SessionDiagnosticEvent {
  readonly kind: SessionDiagnosticKind;
  /** ISO timestamp. */
  readonly at: string;
  /** Turn iteration the event happened in, when known. */
  readonly iteration?: number;
  /** Failure class from `classifyFailure` (`rate_limit`, `server`, …). */
  readonly failureClass?: string;
  /** 1-based retry counter, for `retry`. */
  readonly retryNumber?: number;
  /** Backoff applied before the retry, in ms. */
  readonly delayMs?: number;
  /** Sandbox backend that produced a denial. */
  readonly backend?: string;
  /** Machine-readable denial/escalation reason. */
  readonly reason?: string;
  /** Path the failure named, when one was extracted. */
  readonly path?: string;
  /** Short human-readable detail. */
  readonly detail?: string;
}

/**
 * Cap on retained diagnostics: newest wins.
 *
 * Diagnostics are a forensic aid, not an audit log. A tight cap keeps the
 * header (rewritten in full on every update) from growing without bound in
 * a session that has been alive for days.
 */
export const MAX_SESSION_DIAGNOSTICS = 50;

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
  /**
   * Phase A / Item 6: the plan state. When `undefined`,
   * the session has no plan (the default). The plan
   * lifecycle is managed via `setPlan` / `getPlan`;
   * the field is `readonly` to preserve the Session
   * value-object contract (mutations go through the
   * setter; the metadata reference itself doesn't
   * change).
   */
  plan?: import("./plan/state.js").PlanState;
  /**
   * R4.6 — collaboration mode (Plan / Default / Review).
   * Orthogonal to `plan` document lifecycle. Controls tool
   * policy + prompt guidance; see `plan/mode-kind.ts`.
   */
  collaborationMode?: import("./plan/mode-kind.js").CollaborationModeState;
  /**
   * Phase D / Item 14b: cross-machine resume provenance.
   * Optional; local sessions omit it. Remote resume
   * (mesh adapter) stamps `originNode` / `resumedFrom`.
   */
  provenance?: SessionProvenance;
  /**
   * Bounded, durable record of retries and sandbox denials/escalations.
   *
   * Newest last. Absent when the session has had none, so a clean session
   * header stays clean. See {@link SessionDiagnosticEvent}.
   */
  diagnostics?: ReadonlyArray<SessionDiagnosticEvent>;
}

/** Provenance fields for cross-machine / checkpoint resume. */
export interface SessionProvenance {
  /** Node id that originally created the session (mesh). */
  originNode?: string;
  /** Session id this one was resumed/forked from. */
  resumedFrom?: string;
  /** ISO timestamp of the last checkpoint. */
  checkpointAt?: string;
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
   * Replace the ENTIRE transcript in one durable step.
   *
   * **Why this exists instead of `clear()` + re-append:** that pattern
   * publishes a header-only file first and only then buffers the kept
   * messages, so for a window (a batch interval, or until a crash) the
   * only durable copy of the session is EMPTY. A crash in that window
   * destroyed the whole transcript — the single worst data-loss bug in
   * the harness, reachable from `/compact` and the ACP `compact` method.
   *
   * Implementations must make the swap atomic: the previous transcript
   * stays readable until the new one replaces it, so a crash either
   * leaves the old (longer) transcript or the new one — never nothing.
   */
  replaceMessages(messages: ReadonlyArray<Message>): void;
  /**
   * F-fix: flush any pending persistence writes. The in-memory
   * implementation is a no-op; `PersistedSession` awaits its
   * write chain so the transcript is durable before the CLI
   * returns (fire-and-forget appends would otherwise be lost on
   * an immediate process exit).
   */
  flush(): Promise<void>;
  /**
   * Release the session's resources and flush.
   *
   * **Why this is separate from `flush()`:** `PersistedSession` holds an
   * exclusive *write lease* on its file for as long as it is open. Flushing
   * makes the transcript durable but keeps the lease — so a host that only
   * ever flushes leaves the session file locked, and the next process to
   * open it fails with `SessionFileBusyError` until the stale-PID reclaim
   * heuristic fires. Any owner that finishes with a session it acquired
   * (created or opened) must call `close()`.
   *
   * Optional so non-persisting implementations and test doubles need not
   * implement it; {@link InMemorySession} provides a no-op.
   */
  close?(): Promise<void>;
  /**
   * Append a durable diagnostic record (bounded; newest wins).
   *
   * **Durability differs by implementation, by design.**
   * `PersistedSession` rewrites the header atomically, so the record
   * survives `--resume`; `InMemorySession` keeps it in `metadata`, so
   * tests can assert on it. Callers must not depend on the *timing* of the
   * disk write — it rides the same batched writer as everything else and
   * `flush()`/`close()` makes it durable.
   *
   * Optional so non-persisting doubles need not implement it; both shipped
   * implementations do.
   */
  recordDiagnostic?(event: SessionDiagnosticEvent): void;
  /**
   * Read recorded diagnostics (empty when none).
   *
   * Convenience over `metadata.diagnostics` so callers don't repeat the
   * `?? []`.
   */
  diagnostics?(): ReadonlyArray<SessionDiagnosticEvent>;
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
  /**
   * Phase A / Item 6: set the session's plan state.
   * Pass `undefined` to clear the plan. The plan
   * rides on `metadata.plan`; the metadata object
   * itself is replaced (so `PersistedSession` can
   * write the new state through to disk).
   */
  setPlan(plan: import("./plan/state.js").PlanState | undefined): void;
  /**
   * Phase A / Item 6: read the current plan state, or
   * `undefined` when no plan has been set.
   */
  getPlan(): import("./plan/state.js").PlanState | undefined;
  /**
   * R4.6 — set collaboration mode (Plan / Default / Review).
   */
  setCollaborationMode(
    mode: import("./plan/mode-kind.js").CollaborationModeState,
  ): void;
  /** R4.6 — current collaboration mode (defaults to `default`). */
  getCollaborationMode(): import("./plan/mode-kind.js").CollaborationModeState;
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

  replaceMessages(messages: ReadonlyArray<Message>): void {
    this._messages = messages.map((m) => ({ role: m.role, content: [...m.content] }));
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

  /**
   * Phase A / Item 6: set the session's plan state.
   * The in-memory implementation just mutates
   * `metadata.plan`; `PersistedSession` overrides
   * this to also write the new state through to
   * disk. Pass `undefined` to clear the plan.
   */
  setPlan(plan: import("./plan/state.js").PlanState | undefined): void {
    if (plan === undefined) {
      delete this.metadata.plan;
    } else {
      this.metadata.plan = plan;
    }
  }

  /** Phase A / Item 6: read the current plan state. */
  getPlan(): import("./plan/state.js").PlanState | undefined {
    return this.metadata.plan;
  }

  setCollaborationMode(
    mode: import("./plan/mode-kind.js").CollaborationModeState,
  ): void {
    this.metadata.collaborationMode = mode;
  }

  getCollaborationMode(): import("./plan/mode-kind.js").CollaborationModeState {
    return (
      this.metadata.collaborationMode ?? {
        kind: "default",
        updatedAt: this.metadata.startedAt,
      }
    );
  }

  /** No-op: nothing to flush for an in-memory session. */
  async flush(): Promise<void> {
    // nothing to persist
  }

  async close(): Promise<void> {
    // Nothing to release: the in-memory session holds no lease.
    await this.flush();
  }

  recordDiagnostic(event: SessionDiagnosticEvent): void {
    appendDiagnostic(this.metadata, event);
  }

  diagnostics(): ReadonlyArray<SessionDiagnosticEvent> {
    return this.metadata.diagnostics ?? [];
  }
}

/**
 * Append to a session's bounded diagnostic log (newest last).
 *
 * Shared by both `Session` implementations so the trimming rule cannot
 * diverge: a session that retried 500 times in memory and one that did so
 * on disk must report the same window.
 */
export function appendDiagnostic(
  metadata: SessionMetadata,
  event: SessionDiagnosticEvent,
): void {
  const existing = metadata.diagnostics ?? [];
  const next = [...existing, event];
  metadata.diagnostics =
    next.length > MAX_SESSION_DIAGNOSTICS
      ? next.slice(next.length - MAX_SESSION_DIAGNOSTICS)
      : next;
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
