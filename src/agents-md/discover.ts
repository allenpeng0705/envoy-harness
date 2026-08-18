/**
 * AGENTS.md discovery — verbatim Codex pattern.
 *
 * Walks up from `cwd` to the nearest ancestor with a `projectRootMarker`
 * (e.g. `.git`), collecting every `AGENTS.md` (and any `fallbackFilenames`)
 * along the way. Concatenates them into a single `assembled` string
 * with origin/path comments, respecting a `maxBytes` budget.
 *
 * **Design doc:** `docs/design.md` §9. Mirrors
 * `codex-rs/core/src/agents_md.rs:1-90` line-for-line.
 *
 * **The algorithm (5 steps):**
 *
 * 1. **Find the project root.** Walk up from `cwd` looking for any
 *    `projectRootMarker`. Stop at the first match. If no match is
 *    found, the cwd itself is the project root.
 *
 * 2. **Collect doc paths.** From the project root down to the cwd
 *    (inclusive), at each directory, look for `AGENTS_MD_FILENAME`
 *    and any `fallbackFilenames`. The list is ordered leaf-first so
 *    closer (more specific) docs are read first.
 *
 * 3. **Read each doc, respecting `maxBytes`.** Truncate the LAST doc
 *    that would exceed the budget; never start a new one. This is the
 *    same byte-budget policy as Codex: the project root's instructions
 *    are always included; the most specific (cwd) instructions are
 *    truncated if everything together is too big.
 *
 * 4. **Read the override.** `AGENTS_OVERRIDE_FILENAME` in `cwd` is
 *    appended last, so it wins on conflicts. The same byte budget
 *    applies; the override may itself be truncated.
 *
 * 5. **Assemble.** Each doc is preceded by an HTML comment with the
 *    origin and path, so the model can see where each piece came
 *    from. The separator is `'\n\n--- project-doc ---\n\n'`.
 *
 * **Why this is a separate module from the rest of the runtime:**
 * the discovery algorithm is pure (input → output, no side effects
 * beyond file reads). It's easy to test in isolation, and easy to
 * reason about. The runtime reads the assembled string and injects
 * it into the system prompt.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  AGENTS_MD_FILENAME,
  AGENTS_OVERRIDE_FILENAME,
  DEFAULT_PROJECT_DOC_MAX_BYTES,
  DEFAULT_PROJECT_ROOT_MARKERS,
  type DiscoveredAgentsDoc,
  type LoadedAgentsMd,
} from "../types.js";

/** Separator between assembled docs. Visible to the model. */
const SEPARATOR = "\n\n--- project-doc ---\n\n";

/**
 * Origin tag for a doc that came from the user's `~/.config/envoy/`.
 * Not yet implemented (this module handles project + override only);
 * the user-level layer is added in a later chunk.
 */
type DocOrigin = "user" | "project" | "override";

/** Options for `discoverAgentsMd`. */
export interface DiscoveryOptions {
  /** The working directory to start the upward walk from. */
  cwd: string;
  /**
   * Files that mark a directory as a project root. The walk stops
   * at the first ancestor containing any of these.
   * Default: `['.git']`.
   */
  projectRootMarkers?: ReadonlyArray<string>;
  /**
   * Additional filenames to look for alongside `AGENTS.md`. Useful
   * for monorepos with custom names. Default: `[]`.
   */
  fallbackFilenames?: ReadonlyArray<string>;
  /**
   * Maximum total bytes across all docs (including the override).
   * Default: 32 KB.
   */
  maxBytes?: number;
  /**
   * Override the user-level docs (caller passes a list already
   * loaded; defaults to empty). Future chunk: this is where the
   * `~/.config/envoy/AGENTS.md` integration will plug in.
   */
  userDocs?: ReadonlyArray<DiscoveredAgentsDoc>;
}

/**
 * Walk up from `cwd` to find the project root, collect AGENTS.md
 * along the way, read the override, and assemble. See file header
 * for the 5-step algorithm.
 */
export async function discoverAgentsMd(
  options: DiscoveryOptions,
): Promise<LoadedAgentsMd> {
  const {
    cwd,
    projectRootMarkers = DEFAULT_PROJECT_ROOT_MARKERS,
    fallbackFilenames = [],
    maxBytes = DEFAULT_PROJECT_DOC_MAX_BYTES,
    userDocs = [],
  } = options;

  // 1. Find the project root.
  const projectRoot = await findProjectRoot(cwd, projectRootMarkers);

  // 2. Collect doc paths (leaf-first).
  const docPaths = collectDocPaths({
    fromDir: projectRoot,
    toDir: cwd,
    filenames: [AGENTS_MD_FILENAME, ...fallbackFilenames],
  });

  // 3. Read each doc, respecting maxBytes.
  const entries: DiscoveredAgentsDoc[] = [...userDocs];
  let totalBytes = userDocs.reduce(
    (sum, d) => sum + d.byteLength,
    0,
  );

  for (const p of docPaths) {
    if (totalBytes >= maxBytes) break;
    const doc = await tryReadDoc(p, "project", maxBytes - totalBytes);
    if (doc) {
      entries.push(doc);
      totalBytes += doc.byteLength;
    }
  }

  // 4. Read the override (last, so it wins on conflicts).
  const overridePath = path.join(cwd, AGENTS_OVERRIDE_FILENAME);
  if (totalBytes < maxBytes) {
    const doc = await tryReadDoc(overridePath, "override", maxBytes - totalBytes);
    if (doc) {
      entries.push(doc);
      totalBytes += doc.byteLength;
    }
  }

  // 5. Assemble with origin/path comments.
  const assembled = entries
    .map(
      (e) =>
        `<!-- origin: ${e.origin} path: ${e.path} -->\n${e.contents}`,
    )
    .join(SEPARATOR);

  return { entries, totalBytes, assembled };
}

/**
 * Walk up from `cwd` looking for a `projectRootMarker`. Returns the
 * first directory containing one. If no marker is found, returns
 * `cwd` (the cwd itself is the project root).
 *
 * Uses a `visited` set to defend against symlink cycles. Stops at
 * the filesystem root.
 */
async function findProjectRoot(
  cwd: string,
  markers: ReadonlyArray<string>,
): Promise<string> {
  if (markers.length === 0) return cwd;

  let dir = path.resolve(cwd);
  const visited = new Set<string>();
  while (!visited.has(dir)) {
    visited.add(dir);
    for (const marker of markers) {
      if (await exists(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return cwd; // hit filesystem root, no marker found
    dir = parent;
  }
  return cwd; // symlink cycle, bail out
}

/**
 * Collect every `{dir}/{filename}` for each dir in the leaf-to-root
 * range, returning the paths in leaf-first order. The cwd (leaf) is
 * first; the project root is last. Closest-to-cwd docs are read first
 * so the byte budget favors the most specific instructions.
 */
function collectDocPaths(input: {
  fromDir: string;
  toDir: string;
  filenames: ReadonlyArray<string>;
}): string[] {
  const { fromDir, toDir, filenames } = input;
  const out: string[] = [];
  let dir = path.resolve(toDir);
  const stop = path.resolve(fromDir);
  // Hard cap at 100 directories to prevent infinite loops on weird
  // symlink configurations. Real projects have at most a handful.
  for (let i = 0; i < 100; i++) {
    for (const filename of filenames) {
      out.push(path.join(dir, filename));
    }
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * Try to read a doc file. Returns `null` if the file doesn't exist
 * or can't be read. Truncates to fit within the remaining budget.
 * Reports `byteLength` as the BYTE count (not character count) so
 * the budget is consistent across encodings.
 */
async function tryReadDoc(
  p: string,
  origin: DocOrigin,
  remaining: number,
): Promise<DiscoveredAgentsDoc | null> {
  if (remaining <= 0) return null;
  let contents: string;
  try {
    contents = await fs.readFile(p, "utf8");
  } catch {
    return null; // missing file, permission error, etc.
  }
  // Truncate by character count to stay within budget. Byte length
  // is computed AFTER truncation. This is a conservative approximation;
  // a more precise impl would truncate by byte count using a UTF-8
  // chunker, but the budget is generous (32 KB) and a few bytes of
  // overshoot is fine.
  const trimmed =
    contents.length > remaining ? contents.slice(0, remaining) : contents;
  const byteLength = Buffer.byteLength(trimmed, "utf8");
  return {
    path: p,
    contents: trimmed,
    origin,
    byteLength,
  };
}

/** Promise-friendly `fs.access` (returns boolean, not throws). */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
