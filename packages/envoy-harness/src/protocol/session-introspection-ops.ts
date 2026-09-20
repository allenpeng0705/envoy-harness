/**
 * Read-only session-introspection projections for the protocol backends.
 *
 * **Why these live here.** `agent-backend.ts` sits against the module-size
 * cap, and these three are pure functions of an `Agent` (or of a base config
 * plus per-session labels) — nothing in them touches the live-session map,
 * the lease, or the turn loop. Moving them out is a relocation with no
 * behaviour change, and it is what keeps room for real backend logic.
 */

import type { Agent } from "../agent.js";
import type { Session } from "../session.js";
import { buildTurnOutlineFromMessages } from "../session/turn-outline.js";

/** The per-session labels `getConfig` overlays onto the host's base config. */
export interface SessionConfigLabels {
  model?: string;
  provider?: string;
  /** `null` removes a previously set `baseUrl`; `undefined` leaves it as-is. */
  baseUrl?: string | null;
}

/**
 * Overlay the first labelled session's model settings onto `base`.
 *
 * "First labelled" is deliberate: the status bar shows *a* model, and the
 * ACP session state is what the host asked about. Reordering sessions must
 * not change the answer, so the first labelled one wins.
 */
export function mergeLabeledConfig(
  base: Record<string, unknown>,
  labels: ReadonlyArray<SessionConfigLabels>,
): Record<string, unknown> {
  for (const label of labels) {
    if (label.model === undefined) continue;
    const out: Record<string, unknown> = { ...base, model: label.model };
    if (label.provider !== undefined) out["provider"] = label.provider;
    if (label.baseUrl === null) {
      delete out["baseUrl"];
    } else if (label.baseUrl !== undefined) {
      out["baseUrl"] = label.baseUrl;
    }
    return out;
  }
  return base;
}

/** `session/context` — message count plus accumulated cost. */
export function sessionContextOp(agent: Agent): {
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
} {
  const cost = agent.getCost();
  return {
    messageCount: agent.getMessageCount(),
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    costUsd: cost.costUsd,
  };
}

/** `session/turn_outline` — the turn structure of a transcript. */
export function turnOutlineOp(session: Session): ReturnType<
  typeof buildTurnOutlineFromMessages
> {
  return buildTurnOutlineFromMessages(session.id, session.messages);
}
