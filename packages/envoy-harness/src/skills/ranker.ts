/**
 * R4.6b — ranked skill suggest (prefix > fuzzy > catalog order).
 */

import type { SkillSummary } from "./types.js";

export type SkillRankTier = "prefix" | "fuzzy" | "catalog";

export interface RankedSkill {
  readonly summary: SkillSummary;
  readonly tier: SkillRankTier;
  /** Higher is better within a tier (unused across tiers). */
  readonly score: number;
}

export interface RankSkillsOptions {
  /** Max results (default: all matching / catalog). */
  readonly limit?: number;
  /** When true, only `invocation.userInvocable` skills. Default false. */
  readonly userInvocableOnly?: boolean;
}

function catalogCompare(a: SkillSummary, b: SkillSummary): number {
  return a.name.localeCompare(b.name);
}

/** Query characters appear in order in `hay` (case-insensitive). */
export function isSubsequenceMatch(hay: string, needle: string): boolean {
  if (needle.length === 0) return true;
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  let ji = 0;
  for (let i = 0; i < h.length && ji < n.length; i++) {
    if (h[i] === n[ji]) ji++;
  }
  return ji === n.length;
}

function prefixScore(name: string, query: string): number {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 3;
  if (n.startsWith(q)) return 2;
  // Word-boundary prefix after `-`
  const parts = n.split("-");
  if (parts.some((p) => p.startsWith(q))) return 1;
  return 0;
}

function fuzzyScore(name: string, query: string): number {
  if (!isSubsequenceMatch(name, query)) return 0;
  // Prefer shorter names / denser matches.
  const density = query.length / Math.max(name.length, 1);
  return density;
}

/**
 * Rank skills for slash / palette suggest.
 *
 * Empty query → catalog order (localeCompare by name).
 * Non-empty → prefix matches first, then fuzzy (subsequence),
 * then remaining catalog entries (so UIs can show a full list).
 */
export function rankSkills(
  summaries: ReadonlyArray<SkillSummary>,
  query: string,
  options: RankSkillsOptions = {},
): ReadonlyArray<RankedSkill> {
  const q = query.trim();
  let pool = [...summaries];
  if (options.userInvocableOnly) {
    pool = pool.filter((s) => s.invocation.userInvocable);
  }

  if (q.length === 0) {
    const ranked = pool
      .slice()
      .sort(catalogCompare)
      .map((summary) => ({
        summary,
        tier: "catalog" as const,
        score: 0,
      }));
    return options.limit !== undefined ? ranked.slice(0, options.limit) : ranked;
  }

  const prefix: RankedSkill[] = [];
  const fuzzy: RankedSkill[] = [];
  const rest: RankedSkill[] = [];

  for (const summary of pool) {
    const ps = prefixScore(summary.name, q);
    if (ps > 0) {
      prefix.push({ summary, tier: "prefix", score: ps });
      continue;
    }
    const fs = fuzzyScore(summary.name, q);
    if (fs > 0) {
      fuzzy.push({ summary, tier: "fuzzy", score: fs });
      continue;
    }
    rest.push({ summary, tier: "catalog", score: 0 });
  }

  prefix.sort(
    (a, b) =>
      b.score - a.score || catalogCompare(a.summary, b.summary),
  );
  fuzzy.sort(
    (a, b) =>
      b.score - a.score || catalogCompare(a.summary, b.summary),
  );
  rest.sort((a, b) => catalogCompare(a.summary, b.summary));

  const out = [...prefix, ...fuzzy, ...rest];
  return options.limit !== undefined ? out.slice(0, options.limit) : out;
}
