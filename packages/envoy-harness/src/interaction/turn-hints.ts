/**
 * Structured end-of-turn follow-ups and deferred work (Codex / Claude / DeepSeek parity).
 */

export interface DeferredTask {
  task: string;
  reason: string;
}

export interface TurnHints {
  followUps?: ReadonlyArray<string>;
  deferred?: ReadonlyArray<DeferredTask>;
}

export function emptyTurnHints(): TurnHints {
  return {};
}

export function hasTurnHints(hints: TurnHints): boolean {
  return (
    (hints.followUps !== undefined && hints.followUps.length > 0) ||
    (hints.deferred !== undefined && hints.deferred.length > 0)
  );
}

/** Merge partial hints from repeated `suggest_follow_ups` calls in one turn. */
export function mergeTurnHints(
  base: TurnHints,
  partial: TurnHints,
): TurnHints {
  const followUps =
    partial.followUps !== undefined && partial.followUps.length > 0
      ? [...(base.followUps ?? []), ...partial.followUps]
      : base.followUps;
  const deferred =
    partial.deferred !== undefined && partial.deferred.length > 0
      ? [...(base.deferred ?? []), ...partial.deferred]
      : base.deferred;
  return {
    ...(followUps !== undefined && followUps.length > 0
      ? { followUps: dedupeStrings(followUps) }
      : {}),
    ...(deferred !== undefined && deferred.length > 0 ? { deferred } : {}),
  };
}

function dedupeStrings(items: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
