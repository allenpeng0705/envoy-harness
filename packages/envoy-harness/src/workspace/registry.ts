/**
 * The workspace (project) registry.
 *
 * **What it is.** An ordered, persistent list of project directories the
 * operator has opened, plus the sessions that ran in each. It is the
 * piece that lets a host offer "open a project" and a project-grouped
 * session list, instead of being pinned to whatever directory the process
 * happened to start in.
 *
 * **Why a registry, not just the cwd on each session.** A session already
 * records the directory it ran in (`metadata.cwd`), which is enough to
 * *resume* it. It is not enough to *offer* a project: an empty directory
 * has no sessions yet, and a directory whose sessions were pruned would
 * vanish from the list. The registry is the durable, ordered, user-owned
 * list; sessions are matched to it by resolved path.
 *
 * **What it deliberately does not do.** It never touches the directories
 * themselves — removing a project forgets it, it does not delete it. That
 * separation is the whole reason the registry can be a single JSON file.
 *
 * **Not model-visible.** This is a host/UI concern; nothing here is added
 * to a prompt or a request context.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

/** One project directory. */
export const WorkspaceEntrySchema = z.object({
  /** Absolute, normalized path. Identity of the entry. */
  path: z.string().min(1),
  /** Display name. Defaults to the directory's basename. */
  name: z.string().min(1),
  /** ISO 8601, when the operator added it. */
  addedAt: z.string().datetime(),
  /** ISO 8601, when a session last ran in it. */
  lastUsedAt: z.string().datetime().optional(),
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;

export const WORKSPACE_FILE_FORMAT_VERSION = 1 as const;

export const WorkspaceFileSchema = z.object({
  formatVersion: z.literal(WORKSPACE_FILE_FORMAT_VERSION),
  workspaces: z.array(WorkspaceEntrySchema),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

/** Typed failure so hosts can distinguish "bad path" from "bad file". */
export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NOT_FOUND"
      | "NOT_A_DIRECTORY"
      | "NOT_ABSOLUTE"
      | "OUTSIDE_ROOTS"
      | "MALFORMED_FILE",
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface WorkspaceRegistry {
  list(): Promise<ReadonlyArray<WorkspaceEntry>>;
  /** Add `dir`. Idempotent: re-adding refreshes the name and moves it last. */
  add(dir: string, options?: { name?: string }): Promise<WorkspaceEntry>;
  /** Forget `dir`. Never touches the filesystem entry it names. */
  remove(dir: string): Promise<boolean>;
  /** Mark `dir` as used now (called when a session starts there). */
  touch(dir: string): Promise<WorkspaceEntry | null>;
  has(dir: string): Promise<boolean>;
  /**
   * Would `dir` be accepted? True whenever no roots are configured.
   *
   * Hosts use this to apply the same bound to a client-supplied working
   * directory (`session/new { cwd }`), so `allowedRoots` is a real
   * containment limit rather than one that only covers the picker.
   */
  allows(dir: string): Promise<boolean>;
}

/** Resolve to an absolute, normalized path; `/` and `\` are equivalent here. */
export function normalizeWorkspacePath(dir: string): string {
  return path.resolve(dir);
}

/**
 * Is `real` equal to, or under, one of `roots`?
 *
 * Comparison is on a **separator boundary** (`/tmp/pro` must not admit
 * `/tmp/project-other`) and, on Windows, case-insensitively — drive letters
 * and path segments there are case-preserving but case-insensitive, so a
 * `C:\Users` root must admit `c:\users\proj`.
 *
 * Pure and exported so both modes are unit-testable on any platform.
 */
export function isWithinRoots(
  real: string,
  roots: ReadonlyArray<string>,
  caseInsensitive = false,
): boolean {
  const fold = (s: string): string => (caseInsensitive ? s.toLowerCase() : s);
  const target = fold(real);
  return roots.some((root) => {
    const folded = fold(root);
    if (target === folded) return true;
    const withSep = folded.endsWith(path.sep) ? folded : folded + path.sep;
    return target.startsWith(withSep);
  });
}

export interface FileWorkspaceRegistryOptions {
  /** Path to the JSON file. Missing file = empty registry. */
  filePath: string;
  /**
   * When non-empty, only directories at or under one of these roots may be
   * added. Roots are canonicalized (symlinks resolved) the same way entries
   * are, so a symlink inside a root cannot be used to register a directory
   * outside it.
   *
   * **When to set it:** whenever the registry is reachable by anything other
   * than the operator at the machine — a host bound to a non-loopback
   * address, or a shared environment. Unset means "the local operator may
   * name any directory", which is the right default for a CLI/GUI on one
   * person's machine.
   */
  allowedRoots?: ReadonlyArray<string>;
  /** Clock injection for tests. */
  now?: () => Date;
}

/**
 * A JSON-file-backed registry. Writes are atomic (temp + rename) so a
 * crash cannot leave a half-written list, and serialized through a promise
 * chain so two concurrent `add()` calls cannot clobber each other.
 */
export function createFileWorkspaceRegistry(
  options: FileWorkspaceRegistryOptions,
): WorkspaceRegistry {
  const now = options.now ?? (() => new Date());
  let queue: Promise<unknown> = Promise.resolve();

  /** Serialize every read-modify-write on the registry file. */
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    // Keep the chain alive regardless of individual failures.
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function read(): Promise<WorkspaceEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(options.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new WorkspaceError(
        `workspace registry is not valid JSON: ${(err as Error).message}`,
        "MALFORMED_FILE",
      );
    }
    const result = WorkspaceFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new WorkspaceError(
        `workspace registry has an unsupported shape at ${options.filePath}`,
        "MALFORMED_FILE",
      );
    }
    return result.data.workspaces;
  }

  async function write(entries: WorkspaceEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(options.filePath), { recursive: true });
    const payload: WorkspaceFile = {
      formatVersion: WORKSPACE_FILE_FORMAT_VERSION,
      workspaces: entries,
    };
    // Unique per write, not a fixed `<file>.tmp`: the WebUI and the TUI can
    // each own a registry instance over the same file, and a shared temp
    // path lets one process rename the other's half-written JSON over the
    // target. The in-process lock cannot see across processes.
    const tmp = `${options.filePath}.${process.pid}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    await fs.rename(tmp, options.filePath);
  }

  async function assertIsDirectory(dir: string): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      throw new WorkspaceError(`no such directory: ${dir}`, "NOT_FOUND");
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceError(`not a directory: ${dir}`, "NOT_A_DIRECTORY");
    }
  }

  /**
   * Canonical identity: the resolved path with symlinks followed.
   *
   * **Why realpath, not just `resolve`.** Two reasons that both matter for
   * safety, not tidiness: (1) a symlink registered inside an allowed root
   * would otherwise pass the containment check while pointing outside it;
   * (2) the same directory reached via two names would become two entries.
   *
   * The callers that may legitimately name a directory that no longer
   * exists (`remove` of a deleted project) fall back to the logical
   * resolve, so forgetting a deleted project still works.
   */
  async function canonicalize(dir: string): Promise<string> {
    const resolved = normalizeWorkspacePath(dir);
    try {
      return await fs.realpath(resolved);
    } catch {
      // The path (or part of it) does not exist — normal when forgetting a
      // project whose directory was already deleted. Resolve the deepest
      // existing ancestor and re-append the remainder, so the result still
      // matches what `add` recorded.
      let current = resolved;
      const tail: string[] = [];
      for (;;) {
        const parent = path.dirname(current);
        if (parent === current) return resolved;
        tail.unshift(path.basename(current));
        current = parent;
        try {
          const realParent = await fs.realpath(current);
          return path.join(realParent, ...tail);
        } catch {
          // Keep walking up.
        }
      }
    }
  }

  // Roots are canonicalized once (their realpath), lazily and cached.
  let rootsPromise: Promise<string[]> | undefined;
  function canonicalRoots(): Promise<string[]> {
    rootsPromise ??= Promise.all(
      (options.allowedRoots ?? []).map((r) => canonicalize(r)),
    );
    return rootsPromise;
  }

  function withinRoots(real: string, roots: ReadonlyArray<string>): boolean {
    return isWithinRoots(real, roots, process.platform === "win32");
  }

  return {
    list: () => withLock(read),

    /**
     * Is `dir` inside the configured roots? Always true when none are set.
     *
     * Exposed so a host can apply the same bound to a *client-supplied*
     * working directory, not only to what the picker registers — otherwise
     * `ENVOY_WORKSPACE_ROOTS` looks like containment while `session/new`
     * still accepts any path.
     */
    async allows(dir) {
      if (!path.isAbsolute(dir)) return false;
      const roots = await canonicalRoots();
      if (roots.length === 0) return true;
      return withinRoots(await canonicalize(dir), roots);
    },

    async add(dir, addOptions) {
      return withLock(async () => {
        if (!path.isAbsolute(dir)) {
          throw new WorkspaceError(
            `workspace path must be absolute: ${dir}`,
            "NOT_ABSOLUTE",
          );
        }
        const resolved = normalizeWorkspacePath(dir);
        await assertIsDirectory(resolved);
        // The check runs on the REAL path, so a symlink cannot smuggle a
        // directory past the roots.
        const real = await fs.realpath(resolved);
        const roots = await canonicalRoots();
        if (roots.length > 0 && !withinRoots(real, roots)) {
          throw new WorkspaceError(
            `directory is outside the allowed workspace roots: ${real}`,
            "OUTSIDE_ROOTS",
          );
        }
        const entries = await read();
        const name = addOptions?.name?.trim() || path.basename(real) || real;
        const existing = entries.find((e) => e.path === real);
        const entry: WorkspaceEntry = {
          path: real,
          name,
          addedAt: existing?.addedAt ?? now().toISOString(),
          ...(existing?.lastUsedAt !== undefined
            ? { lastUsedAt: existing.lastUsedAt }
            : {}),
        };
        // Re-adding moves the project to the end (most-recently-opened last,
        // which the UI renders top-down).
        const next = entries.filter((e) => e.path !== real);
        next.push(entry);
        await write(next);
        return entry;
      });
    },

    async remove(dir) {
      return withLock(async () => {
        const resolved = await canonicalize(dir);
        const entries = await read();
        const next = entries.filter((e) => e.path !== resolved);
        if (next.length === entries.length) return false;
        await write(next);
        return true;
      });
    },

    async touch(dir) {
      return withLock(async () => {
        const resolved = await canonicalize(dir);
        const entries = await read();
        const idx = entries.findIndex((e) => e.path === resolved);
        if (idx < 0) return null;
        const updated: WorkspaceEntry = {
          ...entries[idx]!,
          lastUsedAt: now().toISOString(),
        };
        entries[idx] = updated;
        await write(entries);
        return updated;
      });
    },

    async has(dir) {
      const resolved = await canonicalize(dir);
      const entries = await read();
      return entries.some((e) => e.path === resolved);
    },
  };
}
