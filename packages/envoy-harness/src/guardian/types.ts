/**
 * Gap 9 — pluggable Guardian reviewer (Codex-shaped scoring, not model context).
 */

import type { ContentBlock } from "../tools/types.js";

export type GuardianDecision = "allow" | "block";

export interface GuardianReviewResult {
  readonly decision: GuardianDecision;
  /** Optional risk / quality score (forensic only). */
  readonly score?: number;
  readonly reason?: string;
}

export type GuardianToolCall = Extract<
  ContentBlock,
  { type: "tool_call" }
>;

/**
 * Host-injected reviewer. Scores and decisions are recorded on the
 * session diagnostic/event log — never injected into model context.
 */
export interface GuardianReviewer {
  reviewToolBatch(
    calls: ReadonlyArray<GuardianToolCall>,
  ): Promise<GuardianReviewResult> | GuardianReviewResult;
}

/** Default: always allow. */
export const NullGuardian: GuardianReviewer = {
  reviewToolBatch() {
    return { decision: "allow" };
  },
};
