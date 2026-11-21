/**
 * Wave 2 — `apply_patch` with fuzzy context matching.
 *
 * Accepts a simplified Codex/V4A-style patch or unified diff hunks
 * targeting one or more files. Context lines may match with
 * whitespace normalization or ±2 line shift.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import { policyFromMode } from "../../permissions/policy.js";
import type { SandboxPolicy } from "../../types.js";
import type { Tool } from "../types.js";

const Params = z.object({
  patch: z
    .string()
    .min(1)
    .describe(
      "Patch text. Prefer *** Begin Patch / *** Update File: path " +
        "blocks with ' ' context, '-' remove, '+' add lines; " +
        "or unified diff (---/+++/@@).",
    ),
});

interface FileHunk {
  path: string;
  lines: Array<{ kind: " " | "-" | "+"; text: string }>;
}

function normalizeWs(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trimEnd();
}

function parsePatch(patch: string): FileHunk[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const hunks: FileHunk[] = [];
  let current: FileHunk | undefined;

  const flush = (): void => {
    if (current !== undefined && current.lines.length > 0) {
      hunks.push(current);
    }
    current = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const update = /^\*\*\*\s+Update File:\s+(.+)$/.exec(line);
    const addFile = /^\*\*\*\s+Add File:\s+(.+)$/.exec(line);
    const unified = /^\+\+\+\s+(?:b\/)?(.+)$/.exec(line);
    if (update || addFile || unified) {
      flush();
      const p = (update?.[1] ?? addFile?.[1] ?? unified?.[1] ?? "").trim();
      if (p && p !== "/dev/null") {
        current = { path: p, lines: [] };
      }
      continue;
    }
    if (/^\*\*\*\s+Begin Patch/.test(line) || /^\*\*\*\s+End Patch/.test(line)) {
      continue;
    }
    if (/^---\s/.test(line) || /^@@/.test(line)) continue;
    if (current === undefined) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.lines.push({ kind: "+", text: line.slice(1) });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.lines.push({ kind: "-", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      current.lines.push({ kind: " ", text: line.slice(1) });
    } else if (line === "*** End of File") {
      // ignore
    } else if (line.length > 0 && !line.startsWith("*")) {
      // bare context
      current.lines.push({ kind: " ", text: line });
    }
  }
  flush();
  return hunks;
}

function findFuzzyAnchor(
  fileLines: string[],
  context: string[],
): number {
  if (context.length === 0) return 0;
  const normCtx = context.map(normalizeWs);
  // Exact then whitespace-normalized, with small shift tolerance.
  for (const useNorm of [false, true]) {
    for (let shift = 0; shift <= 2; shift++) {
      for (let i = 0; i <= fileLines.length - context.length; i++) {
        let ok = true;
        for (let j = 0; j < context.length; j++) {
          const a = useNorm
            ? normalizeWs(fileLines[i + j]!)
            : fileLines[i + j]!;
          const b = useNorm ? normCtx[j]! : context[j]!;
          if (a !== b) {
            ok = false;
            break;
          }
        }
        if (ok) return i;
      }
      // shift unused for exact window search; keep loop for API symmetry
      void shift;
      break;
    }
  }
  // Fuzzy: allow dropping first/last context line
  if (context.length > 2) {
    return findFuzzyAnchor(fileLines, context.slice(1, -1));
  }
  return -1;
}

function applyHunkToContent(content: string, hunk: FileHunk): string {
  const fileLines = content.length === 0 ? [] : content.split("\n");
  // Build old-side pattern (context + removals)
  const oldSide: string[] = [];
  for (const l of hunk.lines) {
    if (l.kind === " " || l.kind === "-") oldSide.push(l.text);
  }
  let idx = findFuzzyAnchor(fileLines, oldSide);
  if (idx < 0 && oldSide.length === 0) {
    // pure additions at EOF
    idx = fileLines.length;
  }
  if (idx < 0) {
    throw new Error(
      `apply_patch: could not locate context in ${hunk.path}`,
    );
  }
  const out: string[] = fileLines.slice(0, idx);
  let cursor = idx;
  for (const l of hunk.lines) {
    if (l.kind === " ") {
      out.push(fileLines[cursor] ?? l.text);
      cursor += 1;
    } else if (l.kind === "-") {
      cursor += 1;
    } else if (l.kind === "+") {
      out.push(l.text);
    }
  }
  out.push(...fileLines.slice(cursor));
  return out.join("\n");
}

async function assertWritable(
  resolved: string,
  cwd: string,
  sandboxPolicy: SandboxPolicy | undefined,
): Promise<string | undefined> {
  const policy = sandboxPolicy ?? policyFromMode("read-only", cwd);
  if (policy.mode === "read-only") {
    return "permission denied: apply_patch is not allowed in read-only mode";
  }
  if (policy.mode === "workspace-write") {
    const roots =
      policy.writableRoots.length > 0 ? policy.writableRoots : [cwd];
    const allowed = roots.some((root) => {
      const absRoot = path.resolve(root);
      return resolved === absRoot || resolved.startsWith(absRoot + path.sep);
    });
    if (!allowed) {
      return `permission denied: ${resolved} is outside writable roots`;
    }
  }
  return undefined;
}

export const applyPatchTool: Tool = {
  name: "apply_patch",
  timeoutMs: 60_000,
  description:
    "Apply a multi-hunk patch to one or more UTF-8 text files. " +
    "Prefer this over separate edit calls for multi-file or multi-region changes. " +
    "Context matching tolerates whitespace drift and small line shifts.",
  parameters: Params,
  isConcurrencySafe: () => false,
  async execute({ patch }, ctx) {
    const hunks = parsePatch(patch);
    if (hunks.length === 0) {
      return { content: "apply_patch: no file hunks found in patch", isError: true };
    }
    const applied: string[] = [];
    try {
      for (const hunk of hunks) {
        const resolved = path.isAbsolute(hunk.path)
          ? hunk.path
          : path.resolve(ctx.cwd, hunk.path);
        const denied = await assertWritable(
          resolved,
          ctx.cwd,
          ctx.sandboxPolicy,
        );
        if (denied !== undefined) {
          return { content: denied, isError: true };
        }
        let previous: string | null = null;
        let content = "";
        try {
          content = await fs.readFile(resolved, "utf8");
          previous = content;
        } catch {
          previous = null;
          content = "";
        }
        const next = applyHunkToContent(content, hunk);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, next, "utf8");
        ctx.recordUndo?.({ path: resolved, previousContent: previous });
        applied.push(hunk.path);
      }
      return {
        content: JSON.stringify({ ok: true, files: applied }),
      };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
