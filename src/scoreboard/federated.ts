/**
 * Federated scoreboard (§13.3 of the design).
 *
 * **The promise.** A peer running envoy-harness can opt in
 * to a federated scoreboard: pulling rules that have been
 * validated by other peers running envoy-harness, on similar
 * tasks. The pull is opt-in (never push), and the local
 * 5-step protocol is the final gate.
 *
 * **The 3-step pull protocol (v0):**
 *
 * 1. **Fetch.** Query bonded peers for their public scoreboard.
 *    v0: in-memory stub (`LocalPeerSource`). Phase 2: libp2p pubsub.
 * 2. **Filter.** Drop entries with `status !== 'kept'`. Verify
 *    each entry's signature (`verifyEntrySignature`).
 * 3. **Adopt or reject.** Run the local 5-step protocol
 *    against each validated candidate. Adopt iff the local
 *    pass rate is strictly greater than the local baseline.
 *    The result is recorded in `federated-adoptions.yaml`
 *    (the audit trail: "we tried X, the local protocol
 *    said yes/no").
 *
 * **Why pull is opt-in (and push is never a thing):**
 * the design's safety story rests on local evaluation as
 * the final gate. Auto-pushed rules would let a malicious
 * peer inject code paths; the operator must consciously
 * opt in to the federated layer.
 *
 * **Why a stub `PeerSource` in v0:** Phase 2 (mesh-native)
 * is the right place to wire libp2p pubsub. v0 needs the
 * class shape, the type contracts, and the local 5-step
 * gate so the federated layer is correct on its own; the
 * network transport is a separate concern.
 *
 * **Stability:** `PeerSource` is the extension surface. New
 * transports (libp2p, HTTPS webhook, IPFS) implement it.
 * `FederatedScoreboard` is closed to modification; the
 * algorithm is per design §13.3 and changes require a
 * design revision.
 */

import { verifyEntrySignature } from "./storage.js";
import type { ScoreboardEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A peer's public scoreboard. Only the entries that the peer
 * chose to publish are included; the rest stay private.
 * v0: every entry in the scoreboard is public; Phase 2
 * adds a per-entry `public: boolean` field.
 */
export interface PeerScoreboard {
  /** Stable peer id (e.g. peer DID or libp2p peer id). */
  peerId: string;
  /** The peer's published entries, oldest first. */
  entries: ReadonlyArray<ScoreboardEntry>;
}

/**
 * Where to fetch peer scoreboards from. v0 implementations:
 * - `LocalPeerSource` (no network; returns []).
 * - `MockPeerSource` (test fixture; returns predetermined entries).
 * Phase 2: a `Libp2pPeerSource` that subscribes to a pubsub
 * topic and collects responses.
 *
 * **Why a single `fetchScoreboards` method?** the pull
 * protocol is a one-shot request, not a stream. Phase 2
 * may add streaming / subscription semantics via a
 * different method.
 */
export interface PeerSource {
  /**
   * Fetch the current public scoreboards from bonded peers.
   * May return an empty list (no peers, no response yet).
   * May throw on transport errors; the caller is expected
   * to log and continue.
   */
  fetchScoreboards(): Promise<ReadonlyArray<PeerScoreboard>>;
}

// ---------------------------------------------------------------------------
// Default PeerSource implementations
// ---------------------------------------------------------------------------

/**
 * The default `PeerSource`: no network, returns an empty list.
 * v0 has no mesh; the federated pull is a no-op until Phase 2
 * wires a real source.
 *
 * **Why this exists:** callers can wire a `FederatedScoreboard`
 * without conditional checks. The federated layer is "always
 * there, but returns nothing until you give it a real source".
 */
export class LocalPeerSource implements PeerSource {
  async fetchScoreboards(): Promise<ReadonlyArray<PeerScoreboard>> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// FederatedScoreboard
// ---------------------------------------------------------------------------

/** Options for `FederatedScoreboard.pull`. */
export interface PullOptions {
  /**
   * **Opt-in is the safety net.** When `false`, `pull` is a
   * no-op and returns an empty result. Default: `false`.
   * Per design §13.3: "Pull is opt-in, never push."
   */
  optIn?: boolean;
  /**
   * Maximum number of candidates to consider per pull. Limits
   * the blast radius of a malicious or buggy peer. Default: 50.
   */
  maxCandidates?: number;
}

/** The result of a single pull. */
export interface PullResult {
  /** Candidates that passed fetch + filter + verify. */
  validatedCandidates: ReadonlyArray<ScoreboardEntry>;
  /** Entries that were filtered out (with reason). */
  rejected: ReadonlyArray<{ entry: ScoreboardEntry; reason: string }>;
  /** Whether the pull was a no-op (optIn: false). */
  skipped: boolean;
}

/**
 * The federated pull layer. v0 does the fetch + filter +
 * verify; F6.2 adds the local 5-step gate. The class is
 * constructed with a `PeerSource`; the local `SelfEvolve` is
 * injected in F6.2.
 */
export class FederatedScoreboard {
  private peerSource: PeerSource;

  constructor(peerSource: PeerSource) {
    this.peerSource = peerSource;
  }

  /**
   * Pull peer scoreboards. F6.1: returns the validated
   * candidates (filter + verify only). F6.2 will add the
   * local 5-step gate: each candidate runs through the
   * local protocol; adopt iff the local pass rate improves.
   *
   * **Opt-in is the default.** Pass `optIn: true` to
   * actually fetch from peers. The CLI flag is
   * `envoy self-evolve --pull` (per implementation plan F6.4).
   */
  async pull(options: PullOptions = {}): Promise<PullResult> {
    const optIn = options.optIn ?? false;
    if (!optIn) {
      return {
        validatedCandidates: [],
        rejected: [],
        skipped: true,
      };
    }

    const max = options.maxCandidates ?? 50;

    // 1. Fetch.
    let peerScoreboards: ReadonlyArray<PeerScoreboard>;
    try {
      peerScoreboards = await this.peerSource.fetchScoreboards();
    } catch {
      // Transport error. The pull is a no-op; the operator
      // can retry. We do NOT throw — a failed pull should
      // not abort the local cycle.
      return {
        validatedCandidates: [],
        rejected: [],
        skipped: false,
      };
    }

    // 2. Filter + verify.
    const validated: ScoreboardEntry[] = [];
    const rejected: Array<{ entry: ScoreboardEntry; reason: string }> = [];

    for (const peer of peerScoreboards) {
      for (const entry of peer.entries) {
        if (validated.length >= max) break;
        // Status filter: only kept entries are candidates.
        if (entry.status !== "kept") {
          rejected.push({ entry, reason: `status=${entry.status}` });
          continue;
        }
        // Signature verify.
        const ok = await verifyEntrySignature(entry);
        if (!ok) {
          rejected.push({ entry, reason: "signature-invalid" });
          continue;
        }
        validated.push(entry);
      }
      if (validated.length >= max) break;
    }

    return {
      validatedCandidates: validated,
      rejected,
      skipped: false,
    };
  }
}
