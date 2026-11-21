/**
 * Wave 2 — spill store for oversized tool output.
 *
 * When a tool result exceeds `maxInlineChars`, the full body is written
 * under `root` and the caller returns a short locator the model can read.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export interface SpillStore {
  /** Spill `content` if over budget; return locator or original. */
  maybeSpill(
    content: string,
    opts?: { label?: string; maxInlineChars?: number },
  ): Promise<{ content: string; spilled: boolean; path?: string }>;
  read(locatorOrPath: string): Promise<string>;
  readonly root: string;
}

export interface CreateSpillStoreOptions {
  root: string;
  /** Default inline budget. Default 8_000. */
  maxInlineChars?: number;
}

export function createSpillStore(options: CreateSpillStoreOptions): SpillStore {
  const maxInline = options.maxInlineChars ?? 8_000;
  const root = path.resolve(options.root);

  return {
    root,
    async maybeSpill(content, opts) {
      const budget = opts?.maxInlineChars ?? maxInline;
      if (content.length <= budget) {
        return { content, spilled: false };
      }
      await fs.mkdir(root, { recursive: true });
      const id = randomBytes(8).toString("hex");
      const label = (opts?.label ?? "spill").replace(/[^a-zA-Z0-9_-]/g, "_");
      const filePath = path.join(root, `${label}-${id}.txt`);
      await fs.writeFile(filePath, content, "utf8");
      const locator =
        `[spilled ${content.length} chars to ${filePath}; ` +
        `use read_file or spill_read to inspect]`;
      return { content: locator, spilled: true, path: filePath };
    },
    async read(locatorOrPath) {
      const m = /spilled \d+ chars to ([^\];]+)/.exec(locatorOrPath);
      const p = m?.[1]?.trim() ?? locatorOrPath;
      return fs.readFile(p, "utf8");
    },
  };
}
