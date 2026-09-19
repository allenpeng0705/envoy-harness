/**
 * Durable, batched, ordered line writer for the session JSONL.
 *
 * **The five defects this replaces.** `PersistedSession` used to chain
 * `fs.writeFile(path, line + "\n", {flag:"a"})` per message with
 * `.catch(() => {})`:
 *
 * 1. **Errors were swallowed.** A disk-full, permission, or I/O error
 *    silently stopped the log advancing while the in-memory session kept
 *    going. The user only found out at `--resume`, when history was
 *    missing.
 * 2. **No `fsync`.** "Written" meant "handed to the page cache", so a
 *    power loss or kernel panic could lose recent messages.
 * 3. **No durability barrier.** The chain was awaited only at process
 *    exit. A crash mid-turn could leave a `tool_call` durably logged
 *    with its `tool_result` missing — for a tool that already ran. On
 *    resume that is either a provider 400 (OpenAI rejects a dangling
 *    tool call) or a blind re-execution of a side-effecting command.
 * 4. **One `open`/`write`/`close` per message**, plus an unbounded
 *    promise chain in memory.
 * 5. **A crash during a header rewrite** (`setPlan`/`setTitle`, which
 *    rewrite the WHOLE file) could truncate the transcript outright.
 *
 * **The contract this class offers, stated precisely** (DSH's wording is
 * the right one): *on resolution of `append`, the line is buffered and
 * ordered; only a resolved `flush()` promises it survives a crash.*
 *
 * Ordering is total: appends and rewrites share one serial chain, so the
 * file can never interleave a header rewrite with concurrent appends.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

/** One open file handle, as much of it as the writer needs. */
export interface DurableFileHandle {
  writeFile(data: string, encoding: "utf-8"): Promise<void>;
  sync(): Promise<void>;
  truncate(length: number): Promise<void>;
  close(): Promise<void>;
}

/** Filesystem seam so the writer is testable without touching disk. */
export interface DurableFileSystem {
  open(filePath: string, flags: "a"): Promise<DurableFileHandle>;
  stat(filePath: string): Promise<{ size: number }>;
  /** Whole-file write (used for the rewrite temp file). */
  writeFile(filePath: string, data: string): Promise<void>;
  /** Best-effort, used only to roll back a failed append. */
  truncate(filePath: string, length: number): Promise<void>;
  /** Publish a fully-written temp file over the target. */
  rename(from: string, to: string): Promise<void>;
  /**
   * fsync a DIRECTORY so a rename into it is durable.
   *
   * A `rename` updates the directory entry, and the directory's own
   * metadata is not covered by fsyncing the file. Without this, a crash
   * immediately after a publish can lose the new entry entirely — the
   * atomic-swap guarantee would hold for the *data* but not for the
   * *name*. No-op on Windows (see the Node implementation).
   */
  syncDir(dirPath: string): Promise<void>;
}

/** Default Node implementation. */
export const nodeDurableFileSystem: DurableFileSystem = {
  async open(filePath, flags) {
    const handle = await fs.open(filePath, flags);
    return {
      writeFile: (data, encoding) => handle.writeFile(data, encoding),
      sync: () => handle.sync(),
      truncate: (length) => handle.truncate(length),
      close: () => handle.close(),
    };
  },
  async stat(filePath) {
    const stats = await fs.stat(filePath);
    return { size: stats.size };
  },
  async writeFile(filePath, data) {
    await fs.writeFile(filePath, data, "utf-8");
  },
  async truncate(filePath, length) {
    await fs.truncate(filePath, length);
  },
  async rename(from, to) {
    await fs.rename(from, to);
  },
  async syncDir(dirPath) {
    // Windows cannot open a directory as a file handle, and NTFS
    // metadata ordering makes the rename durable with the file's own
    // flush. Everywhere else, fsync the directory.
    if (process.platform === "win32") return;
    const handle = await fs.open(dirPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

export interface DurableLineWriterOptions {
  filePath: string;
  /** Implicit-flush delay once a line is buffered. Default 25 ms. */
  batchDelayMs?: number;
  /** Implicit-flush threshold. Default 256 KiB. */
  maxBatchBytes?: number;
  /** Call `fsync` after each batch. Default true. */
  fsync?: boolean;
  /** Reported once per failure, in addition to `flush()` rejecting. */
  onError?: (err: Error) => void;
  /** Filesystem seam (tests). */
  fs?: DurableFileSystem;
  /** Timer seam (tests). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class DurableLineWriter {
  readonly #filePath: string;
  readonly #batchDelayMs: number;
  readonly #maxBatchBytes: number;
  readonly #fsync: boolean;
  readonly #onError: ((err: Error) => void) | undefined;
  readonly #fs: DurableFileSystem;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;

  #pending: string[] = [];
  #pendingBytes = 0;
  #chain: Promise<void> = Promise.resolve();
  #error: Error | undefined;
  #timer: unknown;
  #closed = false;

  constructor(options: DurableLineWriterOptions) {
    this.#filePath = options.filePath;
    this.#batchDelayMs = options.batchDelayMs ?? 25;
    this.#maxBatchBytes = options.maxBatchBytes ?? 256 * 1024;
    this.#fsync = options.fsync !== false;
    this.#onError = options.onError;
    this.#fs = options.fs ?? nodeDurableFileSystem;
    this.#setTimer =
      options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer =
      options.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Bytes buffered but not yet written. Exposed for diagnostics/tests. */
  get bufferedBytes(): number {
    return this.#pendingBytes;
  }

  /** True once a write has failed and not yet been successfully retried. */
  get hasPendingError(): boolean {
    return this.#error !== undefined;
  }

  /**
   * Buffer one line (no trailing newline). Returns immediately; the
   * write is durable only after a resolved {@link flush}.
   */
  append(line: string): void {
    if (this.#closed) return;
    this.#pending.push(line);
    this.#pendingBytes += Buffer.byteLength(line, "utf8") + 1;
    if (this.#pendingBytes >= this.#maxBatchBytes) {
      this.#drain();
      return;
    }
    this.#armTimer();
  }

  /**
   * Replace the whole file. Buffered appends are dropped, not lost: the
   * caller's `content` already reflects them (a header rewrite is built
   * from the full in-memory transcript).
   */
  rewrite(content: string): void {
    if (this.#closed) return;
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#disarmTimer();
    this.#enqueue(async () => {
      // Write to a sibling temp file and rename, so a crash mid-rewrite
      // leaves the previous transcript intact instead of a truncated
      // one. `writeFile` in place would truncate first — the exact
      // failure mode that could destroy a session during /plan.
      const tmp = `${this.#filePath}.rewrite-${process.pid}.tmp`;
      await this.#fs.writeFile(tmp, content);
      const handle = await this.#fs.open(tmp, "a");
      try {
        if (this.#fsync) await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#fs.rename(tmp, this.#filePath);
      // Durability of the NAME, not just the bytes.
      await this.#fs.syncDir(path.dirname(this.#filePath));
    });
  }

  /**
   * Durability barrier.
   *
   * Resolves only after everything buffered *at the time of the call*
   * has been written and fsynced. **Rejects if any write failed** — the
   * caller must treat that as "this turn cannot be recorded" rather than
   * continuing and silently losing history.
   *
   * A failed batch is re-buffered, so a later `flush()` retries it.
   */
  async flush(): Promise<void> {
    this.#disarmTimer();
    this.#drain();
    await this.#chain;
    if (this.#error !== undefined) {
      const err = this.#error;
      this.#error = undefined;
      throw err;
    }
  }

  /** Flush, then stop accepting work. Errors still propagate. */
  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      this.#closed = true;
      this.#disarmTimer();
    }
  }

  // -------------------------------------------------------------------------

  #armTimer(): void {
    if (this.#timer !== undefined) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      this.#drain();
    }, this.#batchDelayMs);
  }

  #disarmTimer(): void {
    if (this.#timer === undefined) return;
    this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }

  /** Move the current buffer into the serial chain as ONE write. */
  #drain(): void {
    if (this.#pending.length === 0) return;
    const batch = this.#pending.join("\n") + "\n";
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#enqueue(() => this.#writeBatch(batch));
  }

  async #writeBatch(batch: string): Promise<void> {
    let sizeBefore: number | undefined;
    try {
      sizeBefore = (await this.#fs.stat(this.#filePath)).size;
    } catch {
      // File missing: appending creates it, and rollback is a truncate
      // to 0 (or a no-op if the write never started).
      sizeBefore = 0;
    }
    try {
      const handle = await this.#fs.open(this.#filePath, "a");
      try {
        await handle.writeFile(batch, "utf-8");
        if (this.#fsync) await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // A partial append would corrupt the JSONL (a torn line makes the
      // session unreadable). Roll back to the pre-append size.
      try {
        await this.#fs.truncate(this.#filePath, sizeBefore ?? 0);
      } catch {
        /* best effort — the reader also repairs torn tails */
      }
      // Re-buffer so a later flush retries rather than losing history.
      this.#pending.unshift(...batch.replace(/\n$/, "").split("\n"));
      this.#pendingBytes += Buffer.byteLength(batch, "utf8");
      // Reporting is owned by `#enqueue`'s catch — reporting here too
      // would fire `onError` twice for one failure.
      throw error;
    }
  }

  /**
   * Chain one operation, recording (not swallowing) failure so `flush()`
   * can reject while later operations still get their chance.
   */
  #enqueue(fn: () => Promise<void>): void {
    this.#chain = this.#chain.then(fn).catch((err: unknown) => {
      this.#recordFailure(err instanceof Error ? err : new Error(String(err)));
    });
  }

  #recordFailure(error: Error): void {
    if (this.#error === undefined) this.#error = error;
    this.#onError?.(error);
  }
}
