/**
 * Wave 2 — `glob` / `grep` discovery tools (+ optional spill).
 *
 * No `@vscode/ripgrep` dependency: recursive walk + JS line match.
 * Prefer structured results over shell `rg` for policy and spill.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import type { SpillStore } from "../../spill/store.js";
import type { Tool } from "../types.js";

export interface MakeGlobGrepToolsOptions {
  spill?: SpillStore;
  /** Max matches before spill/cap. Default 200. */
  maxMatches?: number;
}

function matchGlob(rel: string, pattern: string): boolean {
  // Minimal glob: ** / * / ? — `**/` may match zero directories.
  const normalized = pattern.replace(/\\/g, "/");
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "{{GLOBSTAR_SLASH}}")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTAR_SLASH\}\}/g, "(?:.*/)?")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  const re = new RegExp(`^${escaped}$`);
  return re.test(rel.replace(/\\/g, "/"));
}

async function walkFiles(
  root: string,
  cwd: string,
  out: string[],
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (signal.aborted) return;
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      await walkFiles(full, cwd, out, signal);
    } else if (ent.isFile()) {
      out.push(path.relative(cwd, full).replace(/\\/g, "/"));
    }
  }
}

export function makeGlobTool(options: MakeGlobGrepToolsOptions = {}): Tool {
  const maxMatches = options.maxMatches ?? 200;
  return {
    name: "glob",
    description:
      "Find file paths under cwd matching a glob pattern (supports *, ?, **).",
    parameters: z.object({
      pattern: z.string().min(1).describe("Glob pattern, e.g. **/*.ts"),
      path: z
        .string()
        .optional()
        .describe("Subdirectory to search (relative to cwd)."),
    }),
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
    async execute(args, ctx) {
      const base = args.path
        ? path.resolve(ctx.cwd, args.path)
        : ctx.cwd;
      const files: string[] = [];
      await walkFiles(base, ctx.cwd, files, ctx.abortSignal);
      const matched = files.filter((f) => matchGlob(f, args.pattern));
      const capped = matched.slice(0, maxMatches);
      let body = capped.join("\n");
      let spilled = false;
      if (matched.length > maxMatches && options.spill) {
        const full = matched.join("\n");
        const s = await options.spill.maybeSpill(full, {
          label: "glob",
          maxInlineChars: 0,
        });
        body =
          capped.join("\n") +
          `\n… +${matched.length - capped.length} more\n` +
          s.content;
        spilled = true;
      } else if (matched.length > maxMatches) {
        body += `\n… +${matched.length - capped.length} more (truncated)`;
      }
      return {
        content: JSON.stringify({
          ok: true,
          count: matched.length,
          truncated: matched.length > maxMatches,
          spilled,
          paths: capped,
          ...(matched.length > maxMatches ? { note: body } : {}),
        }),
      };
    },
  };
}

export function makeGrepTool(options: MakeGlobGrepToolsOptions = {}): Tool {
  const maxMatches = options.maxMatches ?? 200;
  return {
    name: "grep",
    description:
      "Search file contents under cwd for a regex pattern. Returns path:line:text hits.",
    parameters: z.object({
      pattern: z.string().min(1).describe("JavaScript RegExp source."),
      path: z
        .string()
        .optional()
        .describe("File or directory to search (default cwd)."),
      glob: z
        .string()
        .optional()
        .describe("Optional file-path glob filter, e.g. **/*.ts"),
      caseInsensitive: z.boolean().optional(),
    }),
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
    async execute(args, ctx) {
      let re: RegExp;
      try {
        re = new RegExp(
          args.pattern,
          args.caseInsensitive === true ? "i" : undefined,
        );
      } catch (err) {
        return {
          content: `invalid regex: ${
            err instanceof Error ? err.message : String(err)
          }`,
          isError: true,
        };
      }
      const base = args.path
        ? path.resolve(ctx.cwd, args.path)
        : ctx.cwd;
      const files: string[] = [];
      const st = await fs.stat(base).catch(() => undefined);
      if (st?.isFile()) {
        files.push(path.relative(ctx.cwd, base).replace(/\\/g, "/"));
      } else {
        await walkFiles(base, ctx.cwd, files, ctx.abortSignal);
      }
      const filtered =
        args.glob !== undefined
          ? files.filter((f) => matchGlob(f, args.glob!))
          : files;
      const hits: string[] = [];
      for (const rel of filtered) {
        if (ctx.abortSignal.aborted) break;
        if (hits.length >= maxMatches) break;
        const full = path.resolve(ctx.cwd, rel);
        let text: string;
        try {
          text = await fs.readFile(full, "utf8");
        } catch {
          continue;
        }
        // Skip obviously binary
        if (text.includes("\0")) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= maxMatches) break;
          const line = lines[i]!;
          if (re.test(line)) {
            hits.push(`${rel}:${i + 1}:${line.slice(0, 400)}`);
          }
        }
      }
      let spilled = false;
      let note: string | undefined;
      if (hits.length >= maxMatches && options.spill) {
        const s = await options.spill.maybeSpill(hits.join("\n"), {
          label: "grep",
          maxInlineChars: 0,
        });
        spilled = s.spilled;
        note = s.content;
      }
      return {
        content: JSON.stringify({
          ok: true,
          count: hits.length,
          truncated: hits.length >= maxMatches,
          spilled,
          hits,
          ...(note !== undefined ? { spill: note } : {}),
        }),
      };
    },
  };
}

export function makeSpillReadTool(spill: SpillStore): Tool {
  return {
    name: "spill_read",
    description: "Read a previously spilled oversized tool output by path/locator.",
    parameters: z.object({
      path: z.string().min(1).describe("Spill file path or locator string."),
    }),
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const text = await spill.read(args.path);
        return { content: text.slice(0, 100_000) };
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  };
}
