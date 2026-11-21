/**
 * Group persisted sessions by the project (`cwd`) they belong to, for the
 * session rail. Pure — no host or React dependency, so it unit-tests
 * without a server.
 */

import type { SessionSummary } from "./acp/host-types.js";

/** A `cwd` bucket: one section in the session rail. */
export interface ProjectGroup {
  /** Absolute project path, or `""` for the trailing "Other" bucket. */
  cwd: string;
  /** Display label (basename of `cwd`, or "Other"). */
  label: string;
  sessions: SessionSummary[];
}

export const OTHER_PROJECT_LABEL = "Other";

/** Basename of an absolute path, for a section heading. */
export function projectLabel(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (trimmed === "") return OTHER_PROJECT_LABEL;
  const parts = trimmed.split(/[\\/]+/);
  return parts[parts.length - 1] || trimmed;
}

/**
 * Group sessions by `cwd`. Named projects are sorted by label; sessions
 * with an unknown/empty `cwd` land in a final "Other" section, matching
 * the task's contract. When `pinnedIds` is provided, pinned sessions sort
 * first within each group.
 */
export function groupSessionsByProject(
  sessions: readonly SessionSummary[],
  pinnedIds?: ReadonlySet<string>,
): ProjectGroup[] {
  const byCwd = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    // Normalize for *grouping* only: `.. /p/one` and `/p/one/` are the same
    // project, and splitting them would show two sections with one label.
    // The first-seen raw path is kept on the group so "open" uses what the
    // session actually recorded.
    const key = (s.cwd ?? "").trim().replace(/[\\/]+$/, "");
    const bucket = byCwd.get(key);
    if (bucket === undefined) byCwd.set(key, [s]);
    else bucket.push(s);
  }

  const sortList = (list: SessionSummary[]): SessionSummary[] => {
    if (pinnedIds === undefined || pinnedIds.size === 0) return list;
    return [...list].sort((a, b) => {
      const ap = pinnedIds.has(a.id) ? 0 : 1;
      const bp = pinnedIds.has(b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return b.mtimeMs - a.mtimeMs;
    });
  };

  const named: ProjectGroup[] = [];
  let other: ProjectGroup | undefined;
  for (const [key, list] of byCwd) {
    if (key === "") {
      other = {
        cwd: "",
        label: OTHER_PROJECT_LABEL,
        sessions: sortList(list),
      };
      continue;
    }
    const cwd = (list[0]?.cwd ?? key).trim();
    // Same basename under different parents is possible; the rail shows
    // the full path as the row title so they stay distinguishable.
    named.push({
      cwd,
      label: projectLabel(cwd),
      sessions: sortList(list),
    });
  }
  named.sort((a, b) => a.label.localeCompare(b.label));
  return other === undefined ? named : [...named, other];
}

const PINNED_KEY = "eh-web-pinned-sessions";
const ARCHIVED_KEY = "eh-web-archived-sessions";

function readIdSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function writeIdSet(key: string, ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // ignore
  }
}

export function readPinnedSessionIds(): Set<string> {
  return readIdSet(PINNED_KEY);
}

export function writePinnedSessionIds(ids: ReadonlySet<string>): void {
  writeIdSet(PINNED_KEY, ids);
}

/** Wave 7 — archived sessions stay on disk but hide from the default rail. */
export function readArchivedSessionIds(): Set<string> {
  return readIdSet(ARCHIVED_KEY);
}

export function writeArchivedSessionIds(ids: ReadonlySet<string>): void {
  writeIdSet(ARCHIVED_KEY, ids);
}

/**
 * Wave 7 — match title, id, or cwd (case-insensitive substring).
 * Empty query matches everything.
 */
export function sessionMatchesQuery(
  session: SessionSummary,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const title = (session.title ?? "").toLowerCase();
  const id = session.id.toLowerCase();
  const cwd = (session.cwd ?? "").toLowerCase();
  return title.includes(q) || id.includes(q) || cwd.includes(q);
}

export function filterSessions(
  sessions: readonly SessionSummary[],
  query: string,
): SessionSummary[] {
  if (query.trim().length === 0) return [...sessions];
  return sessions.filter((s) => sessionMatchesQuery(s, query));
}

/**
 * Wave 7 — relative age for recent sessions, short date otherwise.
 * Pure so tests can pass a fixed `nowMs`.
 */
export function formatSessionWhen(
  mtimeMs: number,
  nowMs: number = Date.now(),
): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return "";
  const delta = Math.max(0, nowMs - mtimeMs);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 36) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  try {
    return new Date(mtimeMs).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

/** Active list: drop archived unless `showArchived`. */
export function visibleSessions(
  sessions: readonly SessionSummary[],
  archivedIds: ReadonlySet<string>,
  showArchived: boolean,
): SessionSummary[] {
  if (showArchived || archivedIds.size === 0) return [...sessions];
  return sessions.filter((s) => !archivedIds.has(s.id));
}
