/**
 * Sandboxed workspace FS ops for web file-tree / attachments (Wave 2).
 * Paths must stay under the session cwd (and workspace roots when set).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { WorkspaceRegistry } from "../workspace/index.js";
import { WorkspaceError } from "../workspace/index.js";

const ATTACH_DIR = ".envoy-attachments";
const DEFAULT_READ_MAX = 512 * 1024;
const ATTACH_MAX_BYTES = 4 * 1024 * 1024;

export type FsEntryKind = "file" | "dir";

export interface FsEntry {
  name: string;
  path: string;
  kind: FsEntryKind;
}

function isWin(): boolean {
  return process.platform === "win32";
}

function underRoot(root: string, candidate: string): boolean {
  const a = path.resolve(root);
  const b = path.resolve(candidate);
  if (isWin()) {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    return bl === al || bl.startsWith(al.endsWith(path.sep) ? al : al + path.sep);
  }
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

async function resolveSafePath(
  rootCwd: string,
  relativeOrAbs: string | undefined,
  registry: WorkspaceRegistry | undefined,
): Promise<string> {
  const root = path.resolve(rootCwd);
  const target =
    relativeOrAbs === undefined || relativeOrAbs === ""
      ? root
      : path.isAbsolute(relativeOrAbs)
        ? path.resolve(relativeOrAbs)
        : path.resolve(root, relativeOrAbs);

  if (target.includes("\0") || relativeOrAbs?.includes("..")) {
    // Explicit `..` segments after resolve are ok if still under root;
    // reject raw `..` in the request only when it escapes — check underRoot.
  }
  if (!underRoot(root, target)) {
    throw new WorkspaceError(
      `path is outside session cwd: ${target}`,
      "OUTSIDE_ROOTS",
    );
  }
  if (registry !== undefined && !(await registry.allows(root))) {
    throw new WorkspaceError(
      `session cwd is outside the allowed workspace roots: ${root}`,
      "OUTSIDE_ROOTS",
    );
  }
  return target;
}

function safeAttachName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-+=@]+/g, "_");
  const trimmed = base.length > 0 ? base : "file";
  return trimmed.slice(0, 180);
}

/** `workspace/fs/list` — one directory level under session cwd. */
export async function listWorkspaceFsOp(input: {
  rootCwd: string;
  path?: string;
  registry?: WorkspaceRegistry;
}): Promise<{ entries: FsEntry[] }> {
  const dir = await resolveSafePath(
    input.rootCwd,
    input.path,
    input.registry,
  );
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new WorkspaceError(`no such directory: ${dir}`, "NOT_FOUND");
    }
    if (code === "ENOTDIR") {
      throw new WorkspaceError(`not a directory: ${dir}`, "NOT_A_DIRECTORY");
    }
    throw err;
  }
  names.sort((a, b) => a.localeCompare(b));
  const entries: FsEntry[] = [];
  for (const name of names) {
    if (name === "." || name === "..") continue;
    const full = path.join(dir, name);
    if (!underRoot(path.resolve(input.rootCwd), full)) continue;
    let kind: FsEntryKind = "file";
    try {
      const st = await fs.lstat(full);
      if (st.isDirectory()) kind = "dir";
      else if (!st.isFile() && !st.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    entries.push({
      name,
      path: full,
      kind,
    });
  }
  return { entries };
}

/** `workspace/fs/read` — utf8 text under session cwd (binary stub otherwise). */
export async function readWorkspaceFsOp(input: {
  rootCwd: string;
  path: string;
  maxBytes?: number;
  registry?: WorkspaceRegistry;
}): Promise<{
  path: string;
  text?: string;
  truncated?: boolean;
  mime?: string;
  binary?: boolean;
}> {
  const filePath = await resolveSafePath(
    input.rootCwd,
    input.path,
    input.registry,
  );
  const max = input.maxBytes ?? DEFAULT_READ_MAX;
  let buf: Buffer;
  try {
    buf = await fs.readFile(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new WorkspaceError(`no such file: ${filePath}`, "NOT_FOUND");
    }
    if (code === "EISDIR") {
      throw new WorkspaceError(`is a directory: ${filePath}`, "NOT_A_DIRECTORY");
    }
    throw err;
  }
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  if (sample.includes(0)) {
    return { path: filePath, binary: true };
  }
  const truncated = buf.length > max;
  const slice = truncated ? buf.subarray(0, max) : buf;
  const text = slice.toString("utf8");
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === ".json"
      ? "application/json"
      : ext === ".md"
        ? "text/markdown"
        : "text/plain";
  return {
    path: filePath,
    text,
    mime,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** `workspace/attach` — write under `{cwd}/.envoy-attachments/`. */
export async function attachWorkspaceFileOp(input: {
  rootCwd: string;
  name: string;
  dataBase64: string;
  mimeType?: string;
  registry?: WorkspaceRegistry;
}): Promise<{ relativePath: string; path: string; bytes: number }> {
  await resolveSafePath(input.rootCwd, undefined, input.registry);
  let data: Buffer;
  try {
    data = Buffer.from(input.dataBase64, "base64");
  } catch {
    throw new WorkspaceError("invalid base64 data", "NOT_FOUND");
  }
  if (data.length === 0) {
    throw new WorkspaceError("empty attachment", "NOT_FOUND");
  }
  if (data.length > ATTACH_MAX_BYTES) {
    throw new WorkspaceError(
      `attachment exceeds ${ATTACH_MAX_BYTES} bytes`,
      "OUTSIDE_ROOTS",
    );
  }
  const root = path.resolve(input.rootCwd);
  const dir = path.join(root, ATTACH_DIR);
  await fs.mkdir(dir, { recursive: true });
  const safe = safeAttachName(input.name);
  const stamp = Date.now().toString(36);
  const fileName = `${stamp}-${safe}`;
  const full = path.join(dir, fileName);
  if (!underRoot(root, full)) {
    throw new WorkspaceError("attach path escaped cwd", "OUTSIDE_ROOTS");
  }
  await fs.writeFile(full, data);
  const relativePath = path.join(ATTACH_DIR, fileName);
  return { relativePath, path: full, bytes: data.length };
}
