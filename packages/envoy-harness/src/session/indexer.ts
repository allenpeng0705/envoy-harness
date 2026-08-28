/**
 * Phase D / Item 14a — in-memory session index over JSONL.
 *
 * Scans a session directory (same layout as
 * {@link SessionStore}) and builds searchable entries
 * per message. Workspace auth is enforced by the query
 * service (paths must stay under the configured dir).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ContentBlock, Message, Role } from "../tools/types.js";
import type { SessionMetadata } from "../session.js";

/** One indexed message row. */
export interface SessionIndexEntry {
  sessionId: string;
  filePath: string;
  messageIndex: number;
  role: Role;
  /** ISO timestamp when known (from metadata.startedAt + order). */
  ts?: string;
  /** Tool names referenced in this message (calls or results). */
  toolNames: readonly string[];
  /** Flattened searchable text. */
  text: string;
  metadata: SessionMetadata;
}

export interface SessionIndexerOptions {
  /** Absolute path to the session directory. */
  dir: string;
}

function extractToolNames(content: ReadonlyArray<ContentBlock>): string[] {
  const names: string[] = [];
  for (const b of content) {
    if (b.type === "tool_call") names.push(b.name);
  }
  return names;
}

function flattenText(content: ReadonlyArray<ContentBlock>): string {
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "tool_call") {
      parts.push(b.name);
      try {
        parts.push(JSON.stringify(b.args));
      } catch {
        // ignore
      }
    } else if (b.type === "tool_result") {
      parts.push(
        typeof b.content === "string" ? b.content : JSON.stringify(b.content),
      );
    }
  }
  return parts.join("\n");
}

/**
 * Index all `*.jsonl` sessions under `dir`. Corrupt
 * files are skipped (returned in `errors`).
 */
export async function indexSessionDirectory(
  options: SessionIndexerOptions,
): Promise<{ entries: SessionIndexEntry[]; errors: string[] }> {
  const dir = path.resolve(options.dir);
  const entries: SessionIndexEntry[] = [];
  const errors: string[] = [];

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], errors: [] };
    }
    throw err;
  }

  for (const name of files) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = path.join(dir, name);
    try {
      const indexed = await indexSessionFile(filePath, dir);
      entries.push(...indexed);
    } catch (err) {
      errors.push(
        `${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { entries, errors };
}

/** Index a single JSONL session file. */
export async function indexSessionFile(
  filePath: string,
  rootDir: string,
): Promise<SessionIndexEntry[]> {
  const resolved = path.resolve(filePath);
  const root = path.resolve(rootDir);
  if (!isPathInside(resolved, root)) {
    throw new Error(`session file outside workspace: ${filePath}`);
  }

  const raw = await fs.readFile(resolved, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const header = JSON.parse(lines[0]!) as {
    _kind?: string;
    id?: string;
    metadata?: SessionMetadata;
  };
  if (header._kind !== "header" || typeof header.id !== "string") {
    throw new Error("missing or invalid header");
  }
  const metadata = header.metadata ?? {
    cwd: "",
    startedAt: new Date(0).toISOString(),
  };
  const sessionId = header.id;
  const out: SessionIndexEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const msg = JSON.parse(lines[i]!) as Message;
    if (typeof msg.role !== "string" || !Array.isArray(msg.content)) {
      throw new Error(`invalid message at line ${i + 1}`);
    }
    const entry: SessionIndexEntry = {
      sessionId,
      filePath: resolved,
      messageIndex: i - 1,
      role: msg.role,
      toolNames: extractToolNames(msg.content),
      text: flattenText(msg.content),
      metadata,
    };
    if (metadata.startedAt !== undefined) {
      entry.ts = metadata.startedAt;
    }
    out.push(entry);
  }
  return out;
}

/** True when `candidate` is the same as or under `root`. */
export function isPathInside(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
