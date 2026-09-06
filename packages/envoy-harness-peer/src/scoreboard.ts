/**
 * D5 — `PeerScoreboard`: local reputation over `VerdictEntry` records
 * (the shared mesh schema, so the records federate into EnvoyMesh's
 * arbitration store later).
 *
 * R4.11 adds idempotent {@link merge} for peer pull federation.
 */

import type { Verdict, VerdictEntry } from "@envoymesh/protocol";

export interface PeerReputation {
  score: number;
  passCount: number;
  failCount: number;
  partialCount: number;
  entries: readonly VerdictEntry[];
}

export interface ScoreboardMergeResult {
  added: number;
  skipped: number;
}

function entryKey(e: VerdictEntry): string {
  return `${e.chainId}\0${e.subtaskId}\0${e.issuedBy}`;
}

export class PeerScoreboard {
  readonly #entries: VerdictEntry[] = [];
  readonly #keys = new Set<string>();

  /** Append a verdict record. Idempotent by `(chainId, subtaskId, issuedBy)`. */
  record(entry: VerdictEntry): boolean {
    const key = entryKey(entry);
    if (this.#keys.has(key)) return false;
    this.#keys.add(key);
    this.#entries.push(entry);
    return true;
  }

  list(): readonly VerdictEntry[] {
    return [...this.#entries];
  }

  /**
   * R4.11 — merge remote entries idempotently.
   */
  merge(remote: ReadonlyArray<VerdictEntry>): ScoreboardMergeResult {
    let added = 0;
    let skipped = 0;
    for (const e of remote) {
      if (this.record(e)) added += 1;
      else skipped += 1;
    }
    return { added, skipped };
  }

  /** Aggregate reputation for one `(peerId, skillId)` pair. */
  reputationFor(workerPeerId: string, skillId: string): PeerReputation {
    const entries = this.#entries.filter(
      (e) => e.workerPeerId === workerPeerId && e.skillId === skillId,
    );
    let weighted = 0;
    let passCount = 0;
    let failCount = 0;
    let partialCount = 0;
    for (const e of entries) {
      if (e.verdict.kind === "pass") {
        passCount++;
        weighted += e.verdict.score;
      } else if (e.verdict.kind === "fail") {
        failCount++;
      } else {
        partialCount++;
      }
    }
    const score =
      entries.length === 0
        ? 0
        : Math.min(1, Math.max(0, weighted / entries.length));
    return { score, passCount, failCount, partialCount, entries };
  }

  clear(): void {
    this.#entries.length = 0;
    this.#keys.clear();
  }
}

/** OR-of-pass, AND-of-fail, else disputed (the mesh's combination rule). */
export function combinePeerVerdicts(verdicts: readonly Verdict[]): Verdict {
  for (const v of verdicts) if (v.kind === "pass") return v;
  for (const v of verdicts) if (v.kind === "fail") return v;
  return { kind: "disputed", needsHuman: true, signals: ["no decisive verdict"] };
}
