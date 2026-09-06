/**
 * R4.11 — pull VerdictEntry records from registered peers and merge
 * into a local {@link PeerScoreboard}.
 */

import type { PeerRegistry } from "./registry.js";
import type { PeerScoreboard, ScoreboardMergeResult } from "./scoreboard.js";

export interface PullPeerScoreboardsOptions {
  registry: PeerRegistry;
  local: PeerScoreboard;
  /** Optional abort for all peer fetches. */
  signal?: AbortSignal;
}

export interface PeerScoreboardPullResult {
  peersAttempted: number;
  peersOk: number;
  peersFailed: number;
  merge: ScoreboardMergeResult;
  errors: ReadonlyArray<{ peerId: string; error: string }>;
}

/**
 * For each registered peer, call `peer/scoreboard/list` and merge
 * into `local`. Fail-open per peer (errors collected, others continue).
 */
export async function pullPeerScoreboards(
  options: PullPeerScoreboardsOptions,
): Promise<PeerScoreboardPullResult> {
  const peers = options.registry.list();
  let peersOk = 0;
  let peersFailed = 0;
  let added = 0;
  let skipped = 0;
  const errors: Array<{ peerId: string; error: string }> = [];

  for (const peer of peers) {
    if (options.signal?.aborted) {
      errors.push({ peerId: peer.id, error: "pull aborted" });
      peersFailed += 1;
      continue;
    }
    try {
      const entries = await peer.client.listScoreboard(options.signal);
      const m = options.local.merge(entries);
      added += m.added;
      skipped += m.skipped;
      peersOk += 1;
    } catch (err) {
      peersFailed += 1;
      errors.push({
        peerId: peer.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    peersAttempted: peers.length,
    peersOk,
    peersFailed,
    merge: { added, skipped },
    errors,
  };
}
