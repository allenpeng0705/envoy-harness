/**
 * Serialize a session to its on-disk JSONL form (header + messages).
 *
 * Module-level so both the instance method and the static `open()`
 * repair path share one implementation — a second copy is exactly how
 * a "rewrite" silently starts dropping a field.
 */
function serializeSession(
  id: string,
  metadata: SessionMetadata,
  formatVersion: number,
  generation: number,
  messages: ReadonlyArray<Message>,
): string {
  const header: PersistedHeader = {
    _kind: "header",
    id,
    metadata,
    formatVersion,
    ...(formatVersion >= 2 ? { generation } : {}),
  };
  const lines = [JSON.stringify(header)];
  for (const m of messages) lines.push(JSON.stringify(m));
  return `${lines.join("\n")}\n`;
}

/**
 * F14.1 — `PersistedSession`: a `Session` implementation
 * backed by a JSONL file on disk.
 *
 * **File format** (one line per record, newline-
 * terminated):
 *
 * ```
 * {"_kind":"header","id":"<session-id>","metadata":{...}}
 * {"role":"user","content":[...]}
 * {"role":"assistant","content":[...]}
 * {"role":"tool","content":[{"type":"tool_result","toolCallId":"...","content":"...","isError":false}]}
 * {"role":"system","content":[...]}
 * ```
 *
 * **Why JSONL (one record per line):** append-friendly
 * (no rewrite of the whole file per `appendMessage`),
 * streaming-friendly (`fs.readFile` + `split('\n')`
 * loads the whole transcript in O(N) with no
 * parsing library), and human-readable (the user
 * can `cat` their session file and understand it).
 *
 * **Why a `header` line:** the session id and
 * metadata aren't part of the `Message` shape
 * (`{role, content}`). The header is the only
 * special line; the rest are `Message`s. The `_kind`
 * field is a sentinel that distinguishes the header
 * from a `Message` (which has `role`, not `_kind`).
 *
 * **Sync `appendMessage` + buffered durable write:** the `Session`
 * interface is synchronous (13+ call sites), so `appendMessage` pushes
 * to memory and buffers one line in the durable writer. The agent loop
 * awaits `flush()` before each model request and before each tool body,
 * so the on-disk log is a faithful record of what the model saw and
 * what the tools did.
 *
 * **Durability is explicit, not assumed:** the writer batches, `fsync`s,
 * rolls back a partial append to the previous file size, and *rejects*
 * `flush()` on failure instead of swallowing it. A crash mid-append
 * leaves a torn tail that `open()` drops and reports; a crash between a
 * `tool_call` and its result is repaired on load with an explicit
 * "outcome UNKNOWN" result, so a resumed session can neither be rejected
 * by the provider nor silently re-run a side-effecting tool.
 *
 * **Stability:** additive. New fields on the
 * `header` line are forward-compatible (loaders
 * ignore unknown fields). New `Message` shapes
 * would need a migration (the `role` field is the
 * only discriminator; a future `kind` field would
 * let us add new event types).
 */

import { promises as fs } from "node:fs";

import { DurableLineWriter } from "./durable-writer.js";
import {
  EMPTY_REPAIR_REPORT,
  repairDanglingToolCalls,
  splitCompleteLines,
  type SessionRepairReport,
} from "./repair.js";
import * as path from "node:path";

import type { ContentBlock, Message, Role } from "../tools/types.js";
import {
  appendDiagnostic,
  type Session,
  type SessionDiagnosticEvent,
  type SessionMetadata,
} from "../session.js";
import {
  PERSISTED_SESSION_FORMAT_VERSION,
  buildCreateHeader,
  resolveHeaderFormatVersion,
  type PersistedHeader,
} from "./format.js";
import {
  acquireSessionWriteLease,
  type SessionWriteLease,
} from "./write-lease.js";
import { reapStaleRewriteTemps } from "./rewrite-temps.js";

export { PERSISTED_SESSION_FORMAT_VERSION } from "./format.js";

/**
 * Sweep orphaned rewrite temps for `filePath`, swallowing every failure.
 *
 * Litter cleanup must never be the reason a session fails to open: the
 * caller already holds the lease and the transcript is intact, so a
 * refused unlink is not actionable at this layer. `reapStaleRewriteTemps`
 * itself never rejects and reports what it left behind, so a host that
 * wants the detail (a `doctor` check, say) can call it directly.
 */
async function reapOrphanedRewriteTemps(filePath: string): Promise<void> {
  try {
    await reapStaleRewriteTemps(filePath);
  } catch {
    // Best-effort by contract.
  }
}

/**
 * Options for `PersistedSession.create()` (a new
 * session) vs `PersistedSession.open()` (an existing
 * one). The constructors are named for intent; both
 * go through the same internal factory.
 */
export interface PersistedSessionCreateOptions {
  /** The session id. Must be unique within the store. */
  id: string;
  /** The session metadata. */
  metadata: SessionMetadata;
  /** The file path to persist to. */
  filePath: string;
}

/**
 * A `Session` that persists every `appendMessage()`,
 * `setTitle()`, and `clear()` to a JSONL file on
 * disk. The in-memory representation is the source
 * of truth for the agent loop; the file is the
 * durability layer.
 *
 * **Why both in-memory and on-disk:** the agent
 * loop needs O(1) `messages` access; reading the
 * file on every access is too slow for a long
 * session. We load the file once on construction
 * and append to both the in-memory list and the
 * file in lockstep (the file write is fire-and-
 * forget).
 */
export class PersistedSession implements Session {
  readonly id: string;
  readonly metadata: SessionMetadata;
  private _messages: Message[] = [];
  /**
   * Absolute path of the JSONL file backing this session. Public because
   * hosts need it for `--resume`, the session picker, and `doctor`.
   */
  readonly filePath: string;
  private lease: SessionWriteLease | undefined;
  private formatVersion: number;
  private generation: number;
  /**
   * Durable, batched, ordered writer for the JSONL file. Replaced the
   * per-message `writeFile(..., {flag:"a"})` + swallowed-error chain:
   * see `durable-writer.ts` for the five defects it fixes.
   */
  private writer: DurableLineWriter;
  /** What had to be repaired when this session was opened. */
  private repairReport: SessionRepairReport = EMPTY_REPAIR_REPORT;
  /** Last write failure surfaced by the writer (for diagnostics). */
  private lastWriteError: Error | undefined;

  private constructor(
    id: string,
    metadata: SessionMetadata,
    filePath: string,
    formatVersion: number,
    generation: number,
  ) {
    this.id = id;
    this.metadata = { ...metadata };
    this.filePath = filePath;
    this.formatVersion = formatVersion;
    this.generation = generation;
    this.writer = new DurableLineWriter({
      filePath,
      onError: (err) => {
        // Recorded AND reported: never silently swallowed (that was the
        // old behavior, and it hid disk-full / permission failures until
        // the user tried to resume).
        this.lastWriteError = err;
      },
    });
  }

  /** How the log was repaired on open (torn tail / dangling calls). */
  get repairedOnOpen(): SessionRepairReport {
    return this.repairReport;
  }

  /** The most recent write failure, if any (diagnostics / doctor). */
  get writeError(): Error | undefined {
    return this.lastWriteError;
  }

  get messages(): ReadonlyArray<Message> {
    return this._messages;
  }

  /**
   * Create a new `PersistedSession`. The file is
   * written with the header line; no messages.
   * Throws if the file already exists (the host
   * should use `open()` for that).
   */
  static async create(options: PersistedSessionCreateOptions): Promise<PersistedSession> {
    // Best-effort mkdir -p on the parent dir.
    await fs.mkdir(path.dirname(options.filePath), { recursive: true });
    // Check if the file already exists.
    try {
      await fs.access(options.filePath);
      throw new Error(
        `PersistedSession.create: file already exists at ${options.filePath} (id: ${options.id})`,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Re-throw access errors that aren't "doesn't exist".
        throw err;
      }
      // ENOENT: file doesn't exist, proceed.
    }
    const lease = await acquireSessionWriteLease(options.filePath);
    try {
      // A brand-new session file cannot have orphaned temps of its own,
      // but a *reused* path can (`--fork` onto an existing name, a
      // deleted-then-recreated session). Sweeping is free and keeps the
      // directory tidy. Best-effort: never fail a create over litter.
      await reapOrphanedRewriteTemps(options.filePath);
      const header = buildCreateHeader(options.id, options.metadata);
      await fs.writeFile(
        options.filePath,
        JSON.stringify(header) + "\n",
        "utf-8",
      );
      const session = new PersistedSession(
        options.id,
        options.metadata,
        options.filePath,
        PERSISTED_SESSION_FORMAT_VERSION,
        1,
      );
      session.lease = lease;
      return session;
    } catch (err) {
      await lease.release();
      throw err;
    }
  }

  /**
   * Open an existing session for writing (acquires the write lease).
   */
  static async open(filePath: string): Promise<PersistedSession> {
    return PersistedSession.openWithOptions(filePath, { readOnly: false });
  }

  /**
   * Open without a write lease (inspectors / migrate / tests).
   * Mutations still update memory + disk but MUST NOT be used
   * concurrently with another writer — prefer {@link open}.
   */
  static async openReadOnly(filePath: string): Promise<PersistedSession> {
    return PersistedSession.openWithOptions(filePath, { readOnly: true });
  }

  private static async openWithOptions(
    filePath: string,
    options: { readOnly: boolean },
  ): Promise<PersistedSession> {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`PersistedSession.open: file not found: ${filePath}`);
      }
      throw err;
    }
    // A crash mid-append leaves a partial final line. Guessing at it is
    // impossible, so drop it and report — the alternative (throwing
    // "invalid message at line N") made a crashed session permanently
    // unopenable, which is the worst outcome for the only copy of the
    // user's work.
    const { lines: completeLines, torn } = splitCompleteLines(content);
    const lines = completeLines.filter((l) => l.length > 0);
    if (lines.length === 0) {
      throw new Error(`PersistedSession.open: file is empty: ${filePath}`);
    }
    const tornBytes =
      torn === undefined ? 0 : Buffer.byteLength(torn, "utf8");
    // Line 1: header.
    let header: PersistedHeader;
    try {
      const parsed = JSON.parse(lines[0]!) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as Record<string, unknown>)._kind !== "header" ||
        typeof (parsed as Record<string, unknown>).id !== "string"
      ) {
        throw new Error("invalid header line");
      }
      header = parsed as PersistedHeader;
    } catch (err) {
      throw new Error(
        `PersistedSession.open: invalid header in ${filePath}: ${(err as Error).message}`,
      );
    }
    let formatVersion: number;
    try {
      formatVersion = resolveHeaderFormatVersion(header);
    } catch (err) {
      throw new Error(
        `PersistedSession.open: ${(err as Error).message} in ${filePath}`,
      );
    }
    const generation =
      formatVersion >= 2
        ? (header.generation as number)
        : 1;
    const session = new PersistedSession(
      header.id,
      header.metadata,
      filePath,
      formatVersion,
      generation,
    );
    // Lines 2..N: messages.
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("role" in parsed) ||
          !("content" in parsed)
        ) {
          throw new Error("missing role or content");
        }
        session._messages.push(parsed as Message);
      } catch (err) {
        throw new Error(
          `PersistedSession.open: invalid message at line ${i + 1} in ${filePath}: ${(err as Error).message}`,
        );
      }
    }
    // Close any tool_call whose result was never recorded. The tool may
    // already have run, so the model must be told the outcome is unknown
    // rather than being allowed to retry it blindly (or having the
    // provider reject a dangling call outright).
    const closed = repairDanglingToolCalls(session._messages);
    const appendedResults = closed.messages.length - session._messages.length;
    if (appendedResults > 0) {
      session._messages = closed.messages;
    }
    session.repairReport = {
      tornTail: torn !== undefined,
      tornBytes,
      danglingToolCalls: closed.repaired,
    };

    if (!options.readOnly) {
      session.lease = await acquireSessionWriteLease(filePath);
      // We now hold the exclusive write lease, so any rewrite temp for
      // this exact file belongs to a writer that is gone. Sweep them
      // (best-effort) BEFORE the repair rewrite below, so a fresh temp is
      // never confused with an orphan.
      await reapOrphanedRewriteTemps(filePath);
      // Persist the repair so the transcript on disk matches what the
      // model will actually be sent (otherwise every resume re-repairs).
      if (torn !== undefined || closed.repaired > 0) {
        session.writer.rewrite(
          serializeSession(
            session.id,
            session.metadata,
            session.formatVersion,
            session.generation,
            session._messages,
          ),
        );
        await session.writer.flush();
      }
    }
    return session;
  }

  /**
   * Append a message to the transcript.
   *
   * Sync by contract (the `Session` interface is synchronous and has 13+
   * call sites): the in-memory push happens immediately and the line is
   * **buffered** in the durable writer. The return value matches
   * `InMemorySession` (the new length).
   *
   * **Durability:** buffering is not durability. The line survives a
   * crash only after a resolved `flush()` — which the agent loop awaits
   * at the two boundaries that matter (before a model request, and
   * before a tool body). A buffered write is *ordered* but not promised.
   */
  appendMessage(
    role: Role,
    content: ReadonlyArray<ContentBlock>,
  ): number {
    const message: Message = { role, content: [...content] };
    this._messages.push(message);
    // Buffered + ordered. Durable only after a resolved `flush()` — the
    // caller decides when that must happen (see the barriers in
    // `agent/run-loop.ts` and `agent/tool-executor.ts`).
    this.writer.append(JSON.stringify(message));
    return this._messages.length;
  }

  /**
   * Fire-and-forget disk write. The promise is
   * caught and swallowed (we have no logger to
   * pass in; the in-memory state is the source of
   * truth during the run).
   *
   * **Write ordering:** writes are serialized by the durable writer so the file ends up with
   * lines in the order `appendMessage` was called.
   * Without the chain, libuv's threadpool could
   * schedule the writes in parallel, and the
   * relative order of two `flag: "a"` writes is
   * not guaranteed (the OS serializes each write
   * but doesn't promise an order between
   * concurrent calls). The chain is in-process;
   * a different `PersistedSession` instance has
   * its own chain.
   */
  /**
   * The full file contents: header line + one line per message.
   *
   * Used by `rewriteHeader` and `clear`. Building it from the live
   * in-memory transcript means a rewrite can never drop a message the
   * session already holds.
   */
  private serialize(): string {
    return serializeSession(
      this.id,
      this.metadata,
      this.formatVersion,
      this.generation,
      this._messages,
    );
  }

  lastMessage(): Message | null {
    return this._messages[this._messages.length - 1] ?? null;
  }

  /**
   * Replace the entire transcript in ONE atomic publish.
   *
   * The old implementation of this operation was `clear()` (which
   * durably rewrote the file to header-only) followed by re-appending the
   * kept messages. Between those two steps the session's only durable
   * copy was empty, so a crash lost the entire history — and compaction
   * is reachable from `/compact` and from the ACP/SDK `compact` method.
   *
   * Here the new content is serialized and published with a single
   * temp-file + rename, so disk holds either the previous transcript or
   * the new one, never a header-only intermediate.
   */
  replaceMessages(messages: ReadonlyArray<Message>): void {
    this._messages = messages.map((m) => ({
      role: m.role,
      content: [...m.content],
    }));
    this.writer.rewrite(this.serialize());
  }

  /**
   * Clear the transcript. Sync (in-memory reset); the disk rewrite is
   * enqueued in the writer's serial chain so it cannot interleave with
   * in-flight appends. Call `flush()` for durability.
   */
  clear(): void {
    this._messages = [];
    // Rewrite the file with just the header (preserve format).
    this.writer.rewrite(this.serialize());
  }

  /**
   * F14.1: update the display title. Mutates `metadata.title` (in
   * memory) AND enqueues an atomic file rewrite so the title survives a
   * `--resume`.
   *
   * **Why rewrite the whole file:** the header is
   * the first line of the file. Appending the
   * new header would corrupt the format. The file
   * is small (one header + N messages); rewriting
   * the whole file is O(N) for big sessions, but
   * title changes are rare (user-initiated via
   * `/rename`), so the cost is acceptable.
   *
   * **Future optimization:** rewrite just the
   * first line via `fs.read` + `fs.write` at
   * offset 0. For v0 we accept the O(N) cost.
   */
  setTitle(title: string): void {
    this.metadata.title = title;
    this.rewriteHeader();
  }

  /**
   * Phase A / Item 6: set the session's plan state.
   * Same shape as `setTitle` — the metadata is
   * rewritten to disk so the plan survives
   * `--resume`.
   */
  setPlan(plan: import("../plan/state.js").PlanState | undefined): void {
    if (plan === undefined) {
      delete this.metadata.plan;
    } else {
      this.metadata.plan = plan;
    }
    this.rewriteHeader();
  }

  /** Phase A / Item 6: read the current plan state. */
  getPlan(): import("../plan/state.js").PlanState | undefined {
    return this.metadata.plan;
  }

  setCollaborationMode(
    mode: import("../plan/mode-kind.js").CollaborationModeState,
  ): void {
    this.metadata.collaborationMode = mode;
    this.rewriteHeader();
  }

  getCollaborationMode(): import("../plan/mode-kind.js").CollaborationModeState {
    return (
      this.metadata.collaborationMode ?? {
        kind: "default",
        updatedAt: this.metadata.startedAt,
      }
    );
  }

  /**
   * Append a durable diagnostic record and republish the header.
   *
   * **Cost:** `rewriteHeader` serializes header + ALL messages and swaps
   * the file atomically, so this is O(transcript) per record. That is
   * acceptable because only retries and sandbox denials call it and both
   * are rare and bounded — but it is why the log is capped at
   * {@link MAX_SESSION_DIAGNOSTICS} rather than being an unbounded audit
   * trail.
   */
  recordDiagnostic(event: SessionDiagnosticEvent): void {
    appendDiagnostic(this.metadata, event);
    this.rewriteHeader();
  }

  diagnostics(): ReadonlyArray<SessionDiagnosticEvent> {
    return this.metadata.diagnostics ?? [];
  }

  /**
   * Rewrite the JSONL header (first line) without touching the messages.
   * Used by `setTitle`, `setPlan`, `setCollaborationMode`, and
   * `recordDiagnostic`.
   *
   * Goes through the writer's atomic rewrite path (temp file + rename),
   * so a crash mid-rewrite leaves the previous transcript intact rather
   * than truncating it — which a plain in-place `writeFile` would.
   */
  private rewriteHeader(): void {
    this.writer.rewrite(this.serialize());
  }

  /**
   * Durability barrier: resolve only after everything buffered has been
   * written **and fsynced**.
   *
   * **Rejects when a write failed.** Callers that treat the transcript
   * as the record of what happened must not ignore that — the agent loop
   * aborts the turn, and the tool executor refuses to run a tool whose
   * result could not be recorded.
   *
   * (Historical note: this used to say errors "are already swallowed by
   * each chain link". They no longer are — that was the defect.)
   * when the queued writes have been attempted.
   */
  async flush(): Promise<void> {
    // Rejects when a write failed. Callers that treat the transcript as
    // the record of what happened MUST NOT ignore this: continuing would
    // mean acting on state that cannot be recovered.
    await this.writer.flush();
  }

  /**
   * R4.3 — flush and release the write lease so another process
   * can open the same file.
   */
  async close(): Promise<void> {
    await this.writer.close();
    if (this.lease !== undefined) {
      await this.lease.release();
      this.lease = undefined;
    }
  }

  /**
   * Phase D / Item 14b: flush pending writes and stamp
   * `metadata.provenance.checkpointAt`. Optionally merge
   * extra provenance fields (e.g. `resumedFrom`).
   */
  async checkpoint(
    extra?: Partial<import("../session.js").SessionProvenance>,
  ): Promise<void> {
    const prev = this.metadata.provenance ?? {};
    this.metadata.provenance = {
      ...prev,
      ...extra,
      checkpointAt: new Date().toISOString(),
    };
    this.rewriteHeader();
    await this.flush();
  }
}
