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
 * **Sync `appendMessage` + fire-and-forget disk
 * write:** the existing `Session` interface is
 * synchronous (13+ call sites in `agent.ts` use
 * it without `await`). PersistedSession matches:
 * the in-memory push is sync, the disk write is
 * fired in the background. Errors in the disk
 * write are swallowed (no logger to pass in).
 * The in-memory list is the source of truth for
 * the running session; the file is best-effort
 * durability. If the process crashes mid-write,
 * the user can re-run with `--resume` to recover
 * from the file (which is up-to-date as of the
 * last successful write).
 *
 * **No fsync:** durability beyond the OS's normal
 * flushing is the host's concern. F14 doesn't ship
 * an explicit `fsync` — it's a YAGNI. The user can
 * always `--resume` from a different session if the
 * OS crashes.
 *
 * **Stability:** additive. New fields on the
 * `header` line are forward-compatible (loaders
 * ignore unknown fields). New `Message` shapes
 * would need a migration (the `role` field is the
 * only discriminator; a future `kind` field would
 * let us add new event types).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ContentBlock, Message, Role } from "../tools/types.js";
import type { Session, SessionMetadata } from "../session.js";

/**
 * The current JSONL format version. Bump when the
 * on-disk schema changes in a way that requires
 * a migration (vs. an additive change that old
 * readers can ignore).
 *
 * **v1 (F14.1):** initial format. Header line
 * `{_kind: "header", id, metadata, formatVersion: 1}`
 * + one `Message` per line.
 *
 * **Adding formatVersion** is the F14.2 / T1.2
 * pre-release cleanup. The check is in
 * `PersistedSession.open()`: a header with a
 * different `formatVersion` throws a clear error
 * (rather than silently loading a wrong-shape
 * file). Old files without `formatVersion` are
 * treated as v1 (we wrote them all this week; no
 * production data exists yet).
 */
export const PERSISTED_SESSION_FORMAT_VERSION = 1 as const;

/**
 * The JSONL header line. Distinct from a `Message`
 * (which has `role`, not `_kind`).
 *
 * **`formatVersion` is required on write** (the
 * header is built with the current
 * `PERSISTED_SESSION_FORMAT_VERSION`). On read,
 * the field is required for v2+; for v1 (the
 * initial format) it's optional for backward
 * compatibility (an old file without the field
 * loads as v1).
 */
interface PersistedHeader {
  _kind: "header";
  id: string;
  metadata: SessionMetadata;
  /**
   * The on-disk format version. Required for v2+
   * (a missing field on a v2+ file is an error).
   * Optional for v1 (old files without the field
   * are treated as v1).
   */
  formatVersion?: number;
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
  private readonly filePath: string;

  private constructor(id: string, metadata: SessionMetadata, filePath: string) {
    this.id = id;
    this.metadata = { ...metadata };
    this.filePath = filePath;
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
    const session = new PersistedSession(options.id, options.metadata, options.filePath);
    // Write the header line. The formatVersion
    // field is required on write so a future v2+
    // reader can detect (and reject) old files.
    const header: PersistedHeader = {
      _kind: "header",
      id: options.id,
      metadata: options.metadata,
      formatVersion: PERSISTED_SESSION_FORMAT_VERSION,
    };
    await fs.writeFile(options.filePath, JSON.stringify(header) + "\n", "utf-8");
    return session;
  }

  /**
   * Open an existing `PersistedSession` from disk.
   * Reads the file, validates the header, and
   * populates the in-memory message list.
   *
   * Throws if the file doesn't exist or the header
   * is invalid.
   */
  static async open(filePath: string): Promise<PersistedSession> {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`PersistedSession.open: file not found: ${filePath}`);
      }
      throw err;
    }
    const lines = content.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) {
      throw new Error(`PersistedSession.open: file is empty: ${filePath}`);
    }
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
    // T1.2: validate the on-disk format version. The
    // field is OPTIONAL on read (for backward
    // compatibility with v1 files written before
    // this commit) — a missing field means v1.
    // A field with a non-numeric / non-1 value
    // means the file is from a different version
    // of the harness, and we reject it with a
    // clear error.
    if (header.formatVersion !== undefined) {
      if (typeof header.formatVersion !== "number") {
        throw new Error(
          `PersistedSession.open: invalid formatVersion in ${filePath}: ` +
            `expected a number, got ${typeof header.formatVersion}`,
        );
      }
      if (header.formatVersion !== PERSISTED_SESSION_FORMAT_VERSION) {
        throw new Error(
          `PersistedSession.open: unsupported formatVersion ` +
            `${header.formatVersion} in ${filePath} ` +
            `(this build supports version ${PERSISTED_SESSION_FORMAT_VERSION})`,
        );
      }
    }
    // (When the field is undefined, treat as v1:
    // this build is v1, the missing field matches.)
    // The fact that we silently treat undefined as
    // v1 is a forward-compat concession: v2+ must
    // require the field. We enforce that when we
    // bump the version.
    const session = new PersistedSession(header.id, header.metadata, filePath);
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
    return session;
  }

  /**
   * Append a message to the transcript. Sync
   * (matches the `Session` interface contract):
   * the in-memory push is sync, the disk write is
   * fire-and-forget (errors swallowed).
   *
   * The return value matches `InMemorySession`
   * (the new length); the disk write is
   * best-effort.
   */
  appendMessage(
    role: Role,
    content: ReadonlyArray<ContentBlock>,
  ): number {
    const message: Message = { role, content: [...content] };
    this._messages.push(message);
    this.appendLineFireAndForget(JSON.stringify(message));
    return this._messages.length;
  }

  /**
   * Fire-and-forget disk write. The promise is
   * caught and swallowed (we have no logger to
   * pass in; the in-memory state is the source of
   * truth during the run).
   *
   * **Write ordering:** writes are chained via
   * `this.writeChain` so the file ends up with
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
  private writeChain: Promise<void> = Promise.resolve();
  private appendLineFireAndForget(line: string): void {
    this.writeChain = this.writeChain.then(() =>
      fs
        .writeFile(this.filePath, line + "\n", {
          encoding: "utf-8",
          flag: "a",
        })
        .then(() => undefined)
        .catch(() => {
          // Swallow: no logger, no recovery path in v0.
          // The user can recover via --resume.
        }),
    );
  }

  lastMessage(): Message | null {
    return this._messages[this._messages.length - 1] ?? null;
  }

  /**
   * Clear the transcript. Sync (in-memory reset);
   * the disk truncation is fire-and-forget (chained
   * via `writeChain` so it doesn't interleave with
   * in-flight `appendMessage` writes).
   */
  clear(): void {
    this._messages = [];
    // Rewrite the file with just the header.
    const header: PersistedHeader = {
      _kind: "header",
      id: this.id,
      metadata: this.metadata,
      formatVersion: PERSISTED_SESSION_FORMAT_VERSION,
    };
    this.writeChain = this.writeChain.then(() =>
      fs
        .writeFile(
          this.filePath,
          JSON.stringify(header) + "\n",
          "utf-8",
        )
        .then(() => undefined)
        .catch(() => {
          // Swallow: see appendLineFireAndForget.
        }),
    );
  }

  /**
   * F14.1: update the display title. Mutates
   * `metadata.title` (in memory) AND rewrites the
   * file (fire-and-forget) so the title survives
   * a `--resume`.
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

  /**
   * Rewrite the JSONL header (first line) without
   * touching the messages. Used by `setTitle` +
   * `setPlan`. Same error-swallowing pattern.
   */
  private rewriteHeader(): void {
    const header: PersistedHeader = {
      _kind: "header",
      id: this.id,
      metadata: this.metadata,
      formatVersion: PERSISTED_SESSION_FORMAT_VERSION,
    };
    const lines: string[] = [JSON.stringify(header)];
    for (const m of this._messages) {
      lines.push(JSON.stringify(m));
    }
    this.writeChain = this.writeChain.then(() =>
      fs
        .writeFile(this.filePath, lines.join("\n") + "\n", "utf-8")
        .then(() => undefined)
        .catch(() => {
          // Swallow.
        }),
    );
  }

  /**
   * F-fix: await the write chain so the transcript is durable
   * before the CLI returns. Without this, fire-and-forget
   * appends can be lost if the process exits immediately after
   * `run()` (e.g. a host calling `process.exit()`).
   *
   * Errors are already swallowed by each chain link (the
   * in-memory state is the source of truth); `flush()` resolves
   * when the queued writes have been attempted.
   */
  async flush(): Promise<void> {
    await this.writeChain;
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
