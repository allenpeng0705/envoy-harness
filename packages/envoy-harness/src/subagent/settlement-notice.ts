/**
 * DeepSeek-style settlement notice text for the parent session.
 */

import type { SubagentResult } from "./types.js";

const CLOSING_CAP = 8_000;

/**
 * Stable prefix for settlement notices. Must stay in sync with
 * {@link isEphemeralUserContextText} so chat UIs hide these as model-only.
 */
export const SETTLEMENT_NOTICE_PREFIX = "[system] Sub-agent settled:";

export type SettlementNoticeInfo = {
  jobId: string;
  agentId: string;
  result: SubagentResult;
};

/**
 * One model-visible notice that a background child settled.
 * Matches DeepSeek's `createSettlementMessage` vocabulary (status line +
 * closing text), as plain user-role text (envoy has no message-source map).
 */
export function formatSettlementNotice(info: SettlementNoticeInfo): string {
  const summary = settlementSummary(info.agentId, info.result.status);
  const closing = info.result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const capped =
    closing.length > CLOSING_CAP
      ? `${closing.slice(0, CLOSING_CAP)}…`
      : closing;
  const body =
    capped.length === 0
      ? "It left no closing message."
      : `Its closing message:\n${capped}`;
  return `${SETTLEMENT_NOTICE_PREFIX} ${summary} (job=${info.jobId})\n${body}`;
}

function settlementSummary(
  agentId: string,
  status: SubagentResult["status"],
): string {
  const subject = `Background subagent ${agentId}`;
  switch (status) {
    case "completed":
      return `${subject} finished and will do no further work unless you send it more.`;
    case "failed":
      return `${subject} failed before it finished.`;
    case "partial":
      return `${subject} ended with a partial result.`;
    default:
      return `${subject} settled (${String(status)}).`;
  }
}
