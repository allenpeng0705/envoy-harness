/**
 * write — the file-write built-in tool.
 *
 * **Design doc:** §10.1.
 *
 * **Why a tool (vs `bash` with `cat > file`):**
 * structured writes. The model can declare
 * `path` + `content` as separate fields; the
 * `content` is not parsed by a shell, so quotes /
 * newlines / Unicode don't need escaping. The
 * 6 bash validators already block `>` redirects
 * in read-only; this tool honors the same policy
 * via `ToolContext.sandboxPolicy.mode`.
 *
 * **Permission model:**
 * - `read-only` → "permission denied: write is
 *   not allowed in read-only mode" (the model
 *   must use `/sandbox workspace-write` first).
 * - `workspace-write` → allowed when the path is
 *   under `writableRoots` (default: `ctx.cwd`).
 * - `danger-full-access` → always allowed.
 *
 * **Path resolution:** paths are resolved against
 * `ctx.cwd`. Absolute paths in the args bypass cwd
 * (but still go through the permission check).
 *
 * **Atomicity:** v0 uses `fs.writeFile` directly
 * (not write-then-rename). A future chunk can
 * add atomic writes if the harness needs
 * crash-safety for partial writes.
 *
 * **Stability:** the `path` + `content` parameters
 * are required. `createDirectories` defaults to
 * `false` (the model must mkdir explicitly).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import { policyFromMode } from "../../permissions/policy.js";
import type { Tool } from "../types.js";

/**
 * The write tool. Two required parameters: `path`
 * and `content`. One optional: `createDirectories`
 * (default: false).
 */
export const writeTool: Tool<
  z.ZodObject<{
    path: z.ZodString;
    content: z.ZodString;
    createDirectories: z.ZodOptional<z.ZodBoolean>;
  }>
> = {
  name: "write",
  description:
    "Write `content` to the file at `path` (relative to cwd or absolute). " +
    "Overwrites if the file exists; creates if not. Use `createDirectories: true` " +
    "to mkdir -p the parent. Permission is enforced via the agent's sandbox mode " +
    "(read-only rejects writes; workspace-write allows paths under `writableRoots`).",
  parameters: z.object({
    path: z.string().describe("Path to write, relative to cwd or absolute"),
    content: z.string().describe("The full file content to write (UTF-8)"),
    createDirectories: z
      .boolean()
      .optional()
      .describe("If true, mkdir -p the parent directory before writing"),
  }),
  async execute({ path: filePath, content, createDirectories }, ctx) {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(ctx.cwd, filePath);
    const policy = ctx.sandboxPolicy ?? policyFromMode("read-only", ctx.cwd);

    // Permission check: read-only rejects writes.
    if (policy.mode === "read-only") {
      return {
        content:
          "permission denied: write is not allowed in read-only mode " +
          "(use /sandbox workspace-write or pass --sandbox to the agent)",
        isError: true,
      };
    }
    // workspace-write: the resolved path must be
    // under ctx.cwd OR under one of the writableRoots.
    if (policy.mode === "workspace-write") {
      const allowed = policy.writableRoots.some((root) => {
        const absRoot = path.resolve(root);
        return resolved === absRoot || resolved.startsWith(absRoot + path.sep);
      });
      if (!allowed) {
        return {
          content: `permission denied: ${resolved} is not under any writable root`,
          isError: true,
        };
      }
    }
    // danger-full-access: no check.

    try {
      if (createDirectories) {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
      }
      await fs.writeFile(resolved, content, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      return {
        content: `wrote ${bytes} bytes to ${resolved}`,
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        content: `write error: ${e.code ?? "UNKNOWN"}: ${e.message}`,
        isError: true,
      };
    }
  },
};
