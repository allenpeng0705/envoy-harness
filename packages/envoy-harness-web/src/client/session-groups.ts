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
 * the task's contract.
 */
export function groupSessionsByProject(
  sessions: readonly SessionSummary[],
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

  const named: ProjectGroup[] = [];
  let other: ProjectGroup | undefined;
  for (const [key, list] of byCwd) {
    if (key === "") {
      other = { cwd: "", label: OTHER_PROJECT_LABEL, sessions: list };
      continue;
    }
    const cwd = (list[0]?.cwd ?? key).trim();
    // Same basename under different parents is possible; the rail shows
    // the full path as the row title so they stay distinguishable.
    named.push({ cwd, label: projectLabel(cwd), sessions: list });
  }
  named.sort((a, b) => a.label.localeCompare(b.label));
  return other === undefined ? named : [...named, other];
}
