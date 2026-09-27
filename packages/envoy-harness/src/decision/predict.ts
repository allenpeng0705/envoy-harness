/**
 * Shared DecisionClient.predict with timeout — fail-open callers catch.
 */

import type {
  DecisionClient,
  DecisionRequest,
  DecisionResponse,
} from "./types.js";

export async function predictWithTimeout(
  client: DecisionClient,
  req: Omit<DecisionRequest, "signal"> & { signal?: AbortSignal },
  timeoutMs: number,
): Promise<DecisionResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  if (req.signal !== undefined) {
    if (req.signal.aborted) controller.abort();
    else req.signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  try {
    return await client.predict({
      state: req.state,
      questions: req.questions,
      signal: controller.signal,
      ...(req.modelHint !== undefined ? { modelHint: req.modelHint } : {}),
    });
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onOuterAbort);
  }
}
