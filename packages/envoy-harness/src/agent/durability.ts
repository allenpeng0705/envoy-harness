/**
 * The durability barrier.
 *
 * Extracted from `tool-executor.ts` (which must stay under the CI
 * module-size cap) and shared with `run-loop.ts`, because it is one rule
 * enforced at two boundaries and duplicating it is how the two copies
 * drift.
 *
 * **The rule.** Before the agent does something it cannot take back —
 * send the transcript to a model whose reply it will act on, or run a
 * tool that may have side effects — the transcript must be durable. If
 * it is not, we stop: continuing would mean acting on state that cannot
 * be recovered, and a crash would leave a `tool_call` on disk with no
 * result for a tool that already ran. (`repair.ts` closes that gap after
 * the fact; this prevents it.)
 *
 * **Fail-closed by design.** A persistence failure aborts rather than
 * warns. The alternative — the old behavior — was a swallowed error and
 * a silently diverging log.
 */

import type { Session } from "../session.js";

export type DurabilityCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** Await the session's durability barrier, converting throws to a value. */
export async function ensureDurable(session: Session): Promise<DurabilityCheck> {
  try {
    await session.flush();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The operator-facing explanation for a refused turn. */
export function durabilityRefusalMessage(message: string): string {
  return (
    `[aborted] could not persist the session before the next model request: ${message}. ` +
    "Continuing would make the transcript an unreliable record of what happened, " +
    "so the turn stopped. Check free disk space and permissions for the session directory."
  );
}

/** The model-facing explanation for a tool that was not executed. */
export function durabilityToolRefusalMessage(message: string): string {
  return (
    `refused: the session could not be persisted (${message}), so this tool was ` +
    "not executed — its result could not be recorded. Fix the session directory and retry."
  );
}
