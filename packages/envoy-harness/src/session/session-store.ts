/**
 * F14.1 — `SessionStore`: knows the session directory
 * and how to load / save / list / check sessions.
 *
 * **What this is:** a thin directory-aware wrapper
 * around `PersistedSession.create()` /
 * `PersistedSession.open()`. It does NOT own the
 * session instances — it just knows where they
 * live on disk and how to find them.
 *
 * **File layout** (managed by the store):
 *
 * ```
 * <dir>/
 *   <session-id>.jsonl
 *   <session-id>.jsonl
 *   ...
 * ```
 *
 * The session id is the file name (without
 * extension). UUIDs are safe filenames (alphanumeric
 * + dashes).
 *
 * **Why not a database:** JSONL files are append-
 * friendly, human-readable, and easy to inspect
 * (`cat <session-id>.jsonl`). A database would add
 * migration overhead, a new dep, and a new failure
 * mode (corrupt DB). The F9.4 trace layer already
 * uses JSONL for the same reasons — consistency.
 *
 * **Why not just `InMemorySession` everywhere:**
 * the `--resume` and `--fork` CLI flags need to
 * restore / copy the transcript from disk. A
 * `SessionStore` makes that trivial.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { newSessionId } from "../session.js";
import type { SessionMetadata } from "../session.js";
import { PersistedSession } from "./persisted-session.js";

/**
 * Options for `SessionStore.create()`. The store
 * lazily creates the directory on first save (so
 * the constructor is cheap + doesn't fail on a
 * read-only filesystem).
 */
export interface SessionStoreOptions {
  /**
   * The directory where session files live. One
   * JSONL file per session id.
   *
   * **Default:** `~/.local/state/envoy-harness/sessions`
   * (or `$ENVOY_HARNESS_SESSION_DIR` if set). The
   * default is set by the CLI runner; the store
   * itself just uses whatever the host passes.
   */
  dir: string;
}

/**
 * A `SessionStore` is a thin wrapper around a
 * directory. It does NOT own sessions — it just
 * knows where they live and how to find them.
 */
export class SessionStore {
  /** The directory where session files live. */
  readonly dir: string;

  constructor(options: SessionStoreOptions) {
    this.dir = options.dir;
  }

  /** The file path for a given session id. */
  private filePath(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }

  /**
   * Load an existing session by id. Throws if the
   * session doesn't exist or the file is corrupt.
   */
  async load(id: string): Promise<PersistedSession> {
    return PersistedSession.open(this.filePath(id));
  }

  /**
   * Create a new session with a fresh id. The id
   * is embedded in the returned `PersistedSession`;
   * the caller reads it from `.id`.
   */
  async create(metadata: SessionMetadata): Promise<PersistedSession> {
    const id = newSessionId();
    return PersistedSession.create({
      id,
      metadata,
      filePath: this.filePath(id),
    });
  }

  /**
   * Create a session with a specific id. Used by
   * the CLI's `--fork` flag: load an existing
   * session, copy its messages, save under a new
   * id.
   *
   * The caller is responsible for populating the
   * session's messages (via `appendMessage`); the
   * store just creates the file.
   */
  async createWithId(id: string, metadata: SessionMetadata): Promise<PersistedSession> {
    return PersistedSession.create({
      id,
      metadata,
      filePath: this.filePath(id),
    });
  }

  /**
   * Does a session with this id exist?
   */
  async exists(id: string): Promise<boolean> {
    try {
      await fs.access(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all session ids in the store. Sorted by
   * file modification time (most recent first) so
   * the user sees their latest session at the top.
   */
  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
    const ids = entries
      .filter((e) => e.endsWith(".jsonl"))
      .map((e) => e.slice(0, -".jsonl".length));
    // Sort by mtime, most recent first.
    const mtimes = await Promise.all(
      ids.map(async (id) => {
        const stat = await fs.stat(this.filePath(id));
        return { id, mtime: stat.mtimeMs };
      }),
    );
    mtimes.sort((a, b) => b.mtime - a.mtime);
    return mtimes.map((m) => m.id);
  }

  /**
   * Delete a session by id. No-op if it doesn't
   * exist. Returns `true` if a file was deleted.
   */
  async delete(id: string): Promise<boolean> {
    try {
      await fs.unlink(this.filePath(id));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw err;
    }
  }
}
