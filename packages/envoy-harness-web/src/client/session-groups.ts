/**
 * Group persisted sessions for the session rail.
 *
 * Projects come only from the manual workspace registry (deepseek-style).
 * Launch/`process.cwd()` is never promoted to a project heading — sessions
 * whose cwd is not registered land in a trailing "Other" bucket.
 */

import type { SessionSummary } from "./acp/host-types.js";

/** A registered project directory (from `workspace/list`). */
export interface RegisteredProject {
  path: string;
  /** Display name; falls back to basename of `path`. */
  name?: string;
}

/** A project bucket: one section in the session rail. */
export interface ProjectGroup {
  /** Absolute project path, or `""` for the trailing "Other" bucket. */
  cwd: string;
  /** Display label (registry name, basename, or "Other"). */
  label: string;
  sessions: SessionSummary[];
}

/** Sessions not attached to a manually registered project. */
export const OTHER_PROJECT_LABEL = "Ungrouped";

/** Normalize for grouping / registry match (trim + drop trailing separators). */
export function normalizeProjectKey(cwd: string): string {
  const trimmed = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-zA-Z]:\//.test(trimmed)) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }
  return trimmed;
}

/** Basename of an absolute path, for a section heading. */
export function projectLabel(cwd: string): string {
  const trimmed = normalizeProjectKey(cwd);
  if (trimmed === "") return OTHER_PROJECT_LABEL;
  const parts = trimmed.split("/").filter(Boolean);
  return parts[parts.length - 1] || trimmed;
}

/** `parent/basename` — used when two projects would otherwise share a label. */
export function projectLabelWithParent(cwd: string): string {
  const trimmed = normalizeProjectKey(cwd);
  if (trimmed === "") return OTHER_PROJECT_LABEL;
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return parts[parts.length - 1] || trimmed;
}

/**
 * When two+ named groups share the same display label (e.g. monorepo root
 * and `packages/envoy-harness` both → "envoy-harness"), rewrite colliding
 * labels to `parent/basename`. Custom registry names that already differ
 * from the basename are left alone.
 */
export function disambiguateProjectLabels(
  groups: readonly ProjectGroup[],
): ProjectGroup[] {
  const counts = new Map<string, number>();
  for (const g of groups) {
    if (g.cwd === "") continue;
    const key = g.label.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return groups.map((g) => {
    if (g.cwd === "") return g;
    const key = g.label.trim().toLowerCase();
    if ((counts.get(key) ?? 0) <= 1) return g;
    const base = projectLabel(g.cwd);
    // Custom name that isn't just the basename — keep it.
    if (g.label.trim() !== base) return g;
    return { ...g, label: projectLabelWithParent(g.cwd) };
  });
}

function sortSessions(
  list: SessionSummary[],
  pinnedIds: ReadonlySet<string> | undefined,
): SessionSummary[] {
  if (pinnedIds === undefined || pinnedIds.size === 0) return list;
  return [...list].sort((a, b) => {
    const ap = pinnedIds.has(a.id) ? 0 : 1;
    const bp = pinnedIds.has(b.id) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return b.mtimeMs - a.mtimeMs;
  });
}

/**
 * Group sessions under **registered** projects only.
 *
 * - Each registry entry becomes a section (even with zero sessions), in
 *   registry order, labeled by `name` when set.
 * - Sessions whose `cwd` matches a registered path join that section.
 * - Unregistered sessions are **not** shown as projects (deepseek-style:
 *   the Projects rail is registry-only; launch cwd never becomes a heading).
 *
 * When `registered` is omitted, falls back to cwd-inferred groups (legacy
 * / tests). Pass an array (even empty) for deepseek-style manual projects.
 *
 * Pass `includeUngrouped: true` only when a host wants a trailing Ungrouped
 * bucket (tests / alternate UIs). The WebUI Projects rail omits it.
 */
export function groupSessionsByProject(
  sessions: readonly SessionSummary[],
  pinnedIds?: ReadonlySet<string>,
  registered?: readonly RegisteredProject[],
  options?: { includeUngrouped?: boolean },
): ProjectGroup[] {
  if (registered !== undefined) {
    return groupByRegistry(sessions, pinnedIds, registered, options);
  }
  return groupByCwd(sessions, pinnedIds);
}

function groupByRegistry(
  sessions: readonly SessionSummary[],
  pinnedIds: ReadonlySet<string> | undefined,
  registered: readonly RegisteredProject[],
  options?: { includeUngrouped?: boolean },
): ProjectGroup[] {
  const buckets = new Map<string, SessionSummary[]>();
  for (const w of registered) {
    const key = normalizeProjectKey(w.path);
    if (key === "" || buckets.has(key)) continue;
    buckets.set(key, []);
  }

  const other: SessionSummary[] = [];
  for (const s of sessions) {
    const key = normalizeProjectKey(s.cwd ?? "");
    const bucket = key === "" ? undefined : buckets.get(key);
    if (bucket !== undefined) bucket.push(s);
    else other.push(s);
  }

  const named: ProjectGroup[] = [];
  for (const w of registered) {
    const key = normalizeProjectKey(w.path);
    if (key === "") continue;
    const list = buckets.get(key);
    if (list === undefined) continue;
    // Drop after first use so duplicate registry paths don't duplicate sections.
    buckets.delete(key);
    const label =
      w.name !== undefined && w.name.trim().length > 0
        ? w.name.trim()
        : projectLabel(w.path);
    named.push({
      cwd: w.path.trim() || key,
      label,
      sessions: sortSessions(list, pinnedIds),
    });
  }

  const labeled = disambiguateProjectLabels(named);
  if (options?.includeUngrouped !== true || other.length === 0) {
    return labeled;
  }
  return [
    ...labeled,
    {
      cwd: "",
      label: OTHER_PROJECT_LABEL,
      sessions: sortSessions(other, pinnedIds),
    },
  ];
}

/** Legacy: invent a project section per distinct session cwd. */
function groupByCwd(
  sessions: readonly SessionSummary[],
  pinnedIds: ReadonlySet<string> | undefined,
): ProjectGroup[] {
  const byCwd = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const key = normalizeProjectKey(s.cwd ?? "");
    const bucket = byCwd.get(key);
    if (bucket === undefined) byCwd.set(key, [s]);
    else bucket.push(s);
  }

  const named: ProjectGroup[] = [];
  let other: ProjectGroup | undefined;
  for (const [key, list] of byCwd) {
    if (key === "") {
      other = {
        cwd: "",
        label: OTHER_PROJECT_LABEL,
        sessions: sortSessions(list, pinnedIds),
      };
      continue;
    }
    const cwd = (list[0]?.cwd ?? key).trim();
    named.push({
      cwd,
      label: projectLabel(cwd),
      sessions: sortSessions(list, pinnedIds),
    });
  }
  named.sort((a, b) => a.label.localeCompare(b.label));
  const labeled = disambiguateProjectLabels(named);
  return other === undefined ? labeled : [...labeled, other];
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

/** True when `cwd` is one of the manually registered project paths. */
export function isRegisteredProjectCwd(
  cwd: string | undefined,
  registered: readonly RegisteredProject[],
): boolean {
  const key = normalizeProjectKey(cwd ?? "");
  if (key === "") return false;
  return registered.some((w) => normalizeProjectKey(w.path) === key);
}
