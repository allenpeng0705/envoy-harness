/**
 * Wave 1 — pattern/risk Guardian reviewer (no model call).
 *
 * Blocks high-risk bash / write patterns; scores others for forensics.
 */

import type {
  GuardianReviewer,
  GuardianReviewResult,
  GuardianToolCall,
} from "./types.js";

const DANGEROUS_BASH =
  /\b(rm\s+-rf\s+\/|mkfs|dd\s+if=|:\(\)\s*\{\s*:\|:\s*&\s*\};:|curl\s+[^\n]*\|\s*(ba)?sh|wget\s+[^\n]*\|\s*(ba)?sh|chmod\s+-R\s+777|>\s*\/dev\/sd)/i;

const SENSITIVE_WRITE =
  /(^|\/)(\.ssh\/|\.gnupg\/|\.aws\/credentials|\/etc\/passwd|\/etc\/shadow)/i;

function scoreCall(call: GuardianToolCall): {
  score: number;
  reason?: string;
  block: boolean;
} {
  const name = call.name;
  const args = call.args as Record<string, unknown> | undefined;
  if (name === "bash" || name === "job_start") {
    const cmd = String(args?.command ?? args?.cmd ?? "");
    if (DANGEROUS_BASH.test(cmd)) {
      return {
        score: 1,
        block: true,
        reason: `heuristic: dangerous shell pattern in ${name}`,
      };
    }
    if (/\bsudo\b|\bcurl\b|\bwget\b|\bnc\b|\bnmap\b/i.test(cmd)) {
      return { score: 0.6, block: false, reason: `heuristic: elevated risk ${name}` };
    }
    return { score: 0.2, block: false };
  }
  if (name === "write" || name === "edit" || name === "apply_patch") {
    const path = String(args?.path ?? args?.file_path ?? "");
    if (SENSITIVE_WRITE.test(path)) {
      return {
        score: 1,
        block: true,
        reason: `heuristic: sensitive path write (${path})`,
      };
    }
    return { score: 0.3, block: false };
  }
  if (name.startsWith("mcp__") || name === "web_fetch" || name === "web_search") {
    return { score: 0.4, block: false, reason: "heuristic: network tool" };
  }
  return { score: 0.1, block: false };
}

export function createHeuristicGuardian(): GuardianReviewer {
  return {
    reviewToolBatch(calls: ReadonlyArray<GuardianToolCall>): GuardianReviewResult {
      let maxScore = 0;
      const reasons: string[] = [];
      for (const call of calls) {
        const r = scoreCall(call);
        maxScore = Math.max(maxScore, r.score);
        if (r.block) {
          return {
            decision: "block",
            score: r.score,
            ...(r.reason !== undefined ? { reason: r.reason } : {}),
          };
        }
        if (r.reason !== undefined && r.score >= 0.4) {
          reasons.push(r.reason);
        }
      }
      return {
        decision: "allow",
        score: maxScore,
        ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
      };
    },
  };
}
