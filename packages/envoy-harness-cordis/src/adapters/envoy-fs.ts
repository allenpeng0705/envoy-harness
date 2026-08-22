/**
 * C2 — sandbox-gated envoy filesystem adapter for the dsh `ctx.fs`
 * contract.
 *
 * Implements the abstract `@deepseek-ai/dsh-fs` `FileSystem` service over
 * envoy-harness's filesystem semantics, with **sandbox enforcement on
 * mutations**: writes outside the policy's writable roots are denied with
 * `FS_SANDBOX_DENIED` (and any write is denied in `read-only` mode).
 * Reads are allowed anywhere (matches the v1 landlock grant shape —
 * read-only `/`).
 *
 * The per-call `sandboxPolicy` parameter of writeText/editText is accepted
 * but not yet honored (the adapter enforces the policy it was constructed
 * with); honoring per-call overrides is a follow-up.
 */

import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { Context } from "@deepseek-ai/cordis";
import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
  type FsDirEntry,
  type FsEditOutcome,
  type FsEditRequest,
  type FsInfo,
  type FsPathInfo,
  type FsTarget,
  type FsWriteIntent,
  type FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";
import type { SandboxPolicy } from "@envoymesh/envoy-harness";

export interface EnvoyFileSystemOptions {
  /** The envoy sandbox policy governing mutations. */
  policy: SandboxPolicy;
  /** Base cwd for relative-path resolution (default `process.cwd()`). */
  cwd?: string;
}

function versionOf(stats: { mtimeMs: number; size: number }): FsVersion {
  return FsVersion(`${stats.mtimeMs}:${stats.size}`);
}

function mapFsError(err: unknown): FsError {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new FsError("file not found", "FS_NOT_FOUND", { cause: err });
  }
  if (code === "EACCES" || code === "EPERM") {
    return new FsError("permission denied", "FS_PERMISSION_DENIED", {
      cause: err,
    });
  }
  return new FsError(
    err instanceof Error ? err.message : String(err),
    "FS_IO_ERROR",
    { cause: err },
  );
}

export class EnvoyFileSystem extends FileSystem {
  readonly policy: SandboxPolicy;
  readonly cwd: string;

  constructor(ctx: Context, options: EnvoyFileSystemOptions) {
    super(ctx);
    this.policy = options.policy;
    this.cwd = options.cwd ?? process.cwd();
  }

  async resolve(
    input: string,
    opts?: { cwd?: string; signal?: AbortSignal },
  ): Promise<FsTarget> {
    const abs = path.resolve(opts?.cwd ?? this.cwd, input);
    opts?.signal?.throwIfAborted();
    let real = abs;
    try {
      real = await fsp.realpath(abs);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT") throw mapFsError(err);
    }
    return { targetKey: FsTargetKey(real), displayPath: real };
  }

  processPath(target: FsTarget): string {
    return target.displayPath;
  }

  fileUrl(target: FsTarget): string {
    return pathToFileURL(target.displayPath).href;
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    const rel = path.relative(parent.displayPath, child.displayPath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    signal?.throwIfAborted();
    try {
      const s = await fsp.stat(target.displayPath);
      return {
        version: versionOf(s),
        type: s.isDirectory() ? "directory" : s.isFile() ? "file" : "other",
        ...(s.isFile() ? { size: s.size } : {}),
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") return undefined;
      throw mapFsError(err);
    }
  }

  async lstat(
    input: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    signal?.throwIfAborted();
    const abs = path.resolve(opts?.cwd ?? this.cwd, input);
    try {
      const s = await fsp.lstat(abs);
      return {
        version: versionOf(s),
        type: s.isDirectory()
          ? "directory"
          : s.isFile()
            ? "file"
            : s.isSymbolicLink()
              ? "symlink"
              : "other",
        ...(s.isFile() ? { size: s.size } : {}),
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") return undefined;
      throw mapFsError(err);
    }
  }

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const raw = await fsp.readFile(target.displayPath);
    if (raw.includes(0)) {
      throw new FsError(
        `not a text file: ${target.displayPath}`,
        "FS_NOT_TEXT",
      );
    }
    return raw.toString("utf8");
  }

  async streamText(
    target: FsTarget,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<string>> {
    // v1: read whole + yield once (correct text validation over streaming);
    // a chunked stream with NUL rejection is a follow-up.
    const text = await this.readText(target, signal);
    return (async function* () {
      yield text;
    })();
  }

  async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const info = await this.stat(target, signal);
    if (info !== undefined && info.size !== undefined && info.size > maxBytes) {
      throw new FsError(
        `file exceeds read cap: ${target.displayPath}`,
        "FS_TOO_LARGE",
      );
    }
    signal?.throwIfAborted();
    return fsp.readFile(target.displayPath);
  }

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await fsp.readdir(target.displayPath, {
        withFileTypes: true,
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") return [];
      throw mapFsError(err);
    }
    const out: FsDirEntry[] = [];
    for (const e of entries) {
      const childPath = path.join(target.displayPath, e.name);
      let real = childPath;
      try {
        real = await fsp.realpath(childPath);
      } catch {
        // Absent/broken child: keep the joined path (stable identity).
      }
      out.push({
        name: e.name,
        type: e.isDirectory() ? "directory" : e.isFile() ? "file" : "other",
        target: { targetKey: FsTargetKey(real), displayPath: real },
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    this.assertWritable(target);
    const prior = await this.stat(target, signal);
    if (expected?.kind === "createIfAbsent") {
      if (prior !== undefined) {
        throw new FsError(
          `file already exists: ${target.displayPath}`,
          "FS_NOT_OBSERVED",
        );
      }
    } else if (expected?.kind === "replaceIfVersion") {
      if (prior === undefined || prior.version !== expected.version) {
        throw new FsError(
          `stale version for ${target.displayPath}`,
          "FS_STALE_VERSION",
        );
      }
    }
    const before = prior !== undefined ? await this.readText(target, signal) : null;
    await this.atomicWrite(target, content, signal);
    const afterInfo = await this.stat(target, signal);
    return {
      operation: prior === undefined ? "create" : "update",
      version: afterInfo?.version ?? versionOf({ mtimeMs: Date.now(), size: 0 }),
      before,
      after: content,
    };
  }

  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: string },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    this.assertWritable(target);
    const prior = await this.stat(target, signal);
    if (prior === undefined) {
      throw new FsError(`file not found: ${target.displayPath}`, "FS_NOT_FOUND");
    }
    if (expected !== undefined && prior.version !== expected.version) {
      throw new FsError(
        `stale version for ${target.displayPath}`,
        "FS_STALE_VERSION",
      );
    }
    const before = await this.readText(target, signal);
    const normalized = before.replace(/\r\n/g, "\n");
    const old = edit.oldString.replace(/\r\n/g, "\n");
    const matches = normalized.split(old).length - 1;
    if (matches === 0) {
      throw new FsError(
        `edit target not found: ${edit.oldString}`,
        "FS_EDIT_NOT_FOUND",
      );
    }
    if (!edit.replaceAll && matches > 1) {
      throw new FsError(
        `edit target ambiguous (${matches} matches)`,
        "FS_AMBIGUOUS_EDIT",
      );
    }
    const after =
      edit.replaceAll && matches > 0
        ? normalized.split(old).join(edit.newString)
        : normalized.replace(old, edit.newString);
    await this.atomicWrite(target, after, signal);
    const afterInfo = await this.stat(target, signal);
    return {
      version: afterInfo?.version ?? versionOf({ mtimeMs: Date.now(), size: 0 }),
      before: normalized,
      after,
    };
  }

  assertWritable(target: FsTarget): void {
    const roots =
      this.policy.mode === "workspace-write"
        ? this.policy.writableRoots.length > 0
          ? this.policy.writableRoots
          : [this.cwd]
        : [];
    const allowed = roots.some((root) => {
      const rel = path.relative(path.resolve(root), target.displayPath);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    if (!allowed) {
      throw new FsError(
        `write outside writable roots: ${target.displayPath}`,
        "FS_SANDBOX_DENIED",
      );
    }
  }

  async atomicWrite(
    target: FsTarget,
    content: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const dir = path.dirname(target.displayPath);
    const tmp = path.join(
      dir,
      `.${path.basename(target.displayPath)}.envoy-${process.pid}-${Math.random()
        .toString(36)
        .slice(2)}.tmp`,
    );
    try {
      signal?.throwIfAborted();
      await fsp.writeFile(tmp, content, { encoding: "utf8" });
      await fsp.rename(tmp, target.displayPath);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw mapFsError(err);
    }
  }
}
