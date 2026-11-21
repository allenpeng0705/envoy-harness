/**
 * Wave 6 — pure helpers for composer context / changes / turn-hints docks.
 */

export interface DeferredTask {
  task: string;
  reason: string;
}

export interface TurnHints {
  followUps?: ReadonlyArray<string>;
  deferred?: ReadonlyArray<DeferredTask>;
}

export function hasTurnHints(
  hints: TurnHints | null | undefined,
): hints is TurnHints {
  if (hints == null) return false;
  return (
    (hints.followUps !== undefined && hints.followUps.length > 0) ||
    (hints.deferred !== undefined && hints.deferred.length > 0)
  );
}

export function parseTurnHints(raw: unknown): TurnHints | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const followUps = Array.isArray(o.followUps)
    ? mergeUniquePaths(
        o.followUps
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim())
          .filter((x) => x.length > 0),
      )
    : undefined;
  const deferred = Array.isArray(o.deferred)
    ? o.deferred
        .map((item) => {
          if (item === null || typeof item !== "object" || Array.isArray(item)) {
            return null;
          }
          const d = item as Record<string, unknown>;
          if (typeof d.task !== "string" || typeof d.reason !== "string") {
            return null;
          }
          return { task: d.task, reason: d.reason };
        })
        .filter((x): x is DeferredTask => x !== null)
    : undefined;
  const hints: TurnHints = {
    ...(followUps !== undefined && followUps.length > 0 ? { followUps } : {}),
    ...(deferred !== undefined && deferred.length > 0 ? { deferred } : {}),
  };
  return hasTurnHints(hints) ? hints : null;
}

/** Parse `· changed: a, b` from agent_end activity summaries. */
export function parseChangedPathsFromSummary(summary: string): string[] {
  const marker = "changed:";
  const idx = summary.toLowerCase().lastIndexOf(marker);
  if (idx < 0) return [];
  const rest = summary.slice(idx + marker.length).trim();
  if (!rest) return [];
  return mergeUniquePaths(
    rest
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0),
  );
}

function asRecord(args: unknown): Record<string, unknown> | null {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return null;
}

/** Paths mentioned in an apply_patch unified/diff-ish blob. */
export function pathsFromApplyPatch(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const update = line.match(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)\s*$/);
    if (update?.[1]) {
      out.push(update[1].trim());
      continue;
    }
    const plus = line.match(/^\+\+\+\s+(?:b\/)?(.+)\s*$/);
    if (plus?.[1] && plus[1] !== "/dev/null") {
      out.push(plus[1].trim());
    }
  }
  return mergeUniquePaths(out);
}

/**
 * Extract mutating file path(s) from a tool_call activity.
 * Mirrors server-side touchedFiles tracking for write/edit (+ apply_patch).
 */
export function pathsFromMutatingTool(
  toolName: string | undefined,
  args: unknown,
): string[] {
  if (toolName === undefined) return [];
  const o = asRecord(args);
  if (toolName === "write" || toolName === "edit") {
    if (o !== null && typeof o.path === "string" && o.path.length > 0) {
      return [o.path];
    }
    return [];
  }
  if (toolName === "apply_patch" || toolName === "apply-patch") {
    if (o !== null && typeof o.patch === "string") {
      return pathsFromApplyPatch(o.patch);
    }
  }
  return [];
}

export function mergeUniquePaths(
  ...lists: ReadonlyArray<ReadonlyArray<string>>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const p = raw.trim();
      if (p.length === 0 || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export function basenameLabel(path: string): string {
  const n = path.replace(/\\/g, "/");
  const parts = n.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
