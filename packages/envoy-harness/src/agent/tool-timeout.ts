/**
 * Per-tool execution timeouts.
 *
 * **The gap this closes.** `bash` (30 s), MCP (10 s), LSP (15 s), pty
 * (5 s) and jobs (60 s) each carried their own ad-hoc deadline, but
 * `read_file`, `write`, `edit` and `git` had none. A stuck NFS mount, a
 * credential prompt, or a hung `git` could therefore hang a turn
 * **forever** — the user's only recourse was killing the process, losing
 * the session.
 *
 * **Why the deadline is cooperative plus bounded (not a bare
 * `Promise.race`).** Two failure modes pull in opposite directions:
 *
 * - Racing immediately and abandoning the body produces a *lie*: we
 *   report "timed out" while the operation may still be running and may
 *   still take effect (a half-written file, a process still mutating the
 *   tree). Deepseek-harness rejects this deliberately — it reaches
 *   quiescence first so the substituted result is truthful and no
 *   started body is left detached from its result.
 * - Waiting for quiescence alone does not bound anything: a tool that
 *   ignores its abort signal (a bare `fs` call cannot be cancelled)
 *   still hangs.
 *
 * So: fire the deadline, hand the tool a derived signal to cancel
 * *cooperatively*, and then wait a short grace period for it to settle.
 * If it does, we use its real outcome (and label a deadline-induced
 * failure as a timeout). If it does not, we return a timeout result that
 * explicitly says the operation was **abandoned and may still be
 * running** — bounded, and honest about what we do not know.
 */

/** Default wall-clock budget for a tool that declares none. */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/**
 * How long to wait, after the deadline, for a cooperatively-cancelled
 * tool to settle before abandoning it.
 */
export const TOOL_TIMEOUT_GRACE_MS = 2_000;

/** Raised into the tool's derived signal when the deadline fires. */
export class ToolTimeoutError extends Error {
  override readonly name = "ToolTimeoutError";
  readonly code = "TOOL_TIMEOUT" as const;
  constructor(readonly timeoutMs: number) {
    super(`tool timed out after ${timeoutMs}ms`);
  }
}

/** True when a failure was caused by our own deadline. */
export function isToolTimeout(err: unknown): boolean {
  return (
    err instanceof ToolTimeoutError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === "TOOL_TIMEOUT")
  );
}

export interface ToolTimeoutOutcome<T> {
  readonly result: T;
  readonly timedOut: boolean;
  /**
   * Set when the body did not settle within the grace period. The
   * operation may still be running: the caller MUST NOT assume it had no
   * effect.
   */
  readonly abandoned: boolean;
}

/**
 * Run `body` under a wall-clock budget.
 *
 * @param timeoutMs budget; `undefined` uses
 *   {@link DEFAULT_TOOL_TIMEOUT_MS}, `0` disables the budget.
 * @param signal the caller's signal (an outer abort is never reported as
 *   a timeout, and is propagated to the tool immediately)
 * @param onTimeout builds the result to report when the deadline fires
 */
export async function runWithToolTimeout<T>(options: {
  timeoutMs: number | undefined;
  signal: AbortSignal;
  body: (signal: AbortSignal) => Promise<T>;
  onTimeout: (info: { timeoutMs: number; abandoned: boolean }) => T;
  /** Grace after the deadline. Injectable for tests. */
  graceMs?: number;
  /** Timer seam for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): Promise<ToolTimeoutOutcome<T>> {
  const budget =
    options.timeoutMs === undefined
      ? DEFAULT_TOOL_TIMEOUT_MS
      : options.timeoutMs;
  const graceMs = options.graceMs ?? TOOL_TIMEOUT_GRACE_MS;
  const setTimer =
    options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  // No budget: run straight through, still forwarding the caller's signal.
  if (budget <= 0) {
    return {
      result: await options.body(options.signal),
      timedOut: false,
      abandoned: false,
    };
  }

  const derived = new AbortController();
  let deadlineFired = false;
  const onOuterAbort = (): void => {
    derived.abort(options.signal.reason);
  };
  if (options.signal.aborted) {
    derived.abort(options.signal.reason);
  } else {
    options.signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  const timer = setTimer(() => {
    deadlineFired = true;
    derived.abort(new ToolTimeoutError(budget));
  }, budget);

  const bodyPromise = (async () => {
    try {
      return { ok: true as const, value: await options.body(derived.signal) };
    } catch (err) {
      return { ok: false as const, error: err };
    }
  })();

  // Race against the grace window only (the deadline already aborted the
  // derived signal). A tool that honours it settles promptly.
  let graceHandle: unknown;
  const gracePromise = new Promise<"grace">((resolve) => {
    graceHandle = setTimer(() => resolve("grace"), graceMs);
  });

  try {
    const settled = await Promise.race([
      bodyPromise.then((outcome) => ({ kind: "body" as const, outcome })),
      gracePromise.then(() => ({ kind: "grace" as const })),
    ]);

    if (settled.kind === "grace") {
      // Cooperative cancellation did not take. Report a timeout that is
      // explicit about the uncertainty.
      return {
        result: options.onTimeout({ timeoutMs: budget, abandoned: true }),
        timedOut: true,
        abandoned: true,
      };
    }

    const { outcome } = settled;
    if (outcome.ok) {
      return { result: outcome.value, timedOut: false, abandoned: false };
    }
    if (deadlineFired && !options.signal.aborted) {
      return {
        result: options.onTimeout({ timeoutMs: budget, abandoned: false }),
        timedOut: true,
        abandoned: false,
      };
    }
    // A genuine tool failure (or an outer abort) — rethrow so the caller's
    // normal error handling applies.
    throw outcome.error;
  } finally {
    clearTimer(timer);
    clearTimer(graceHandle);
    options.signal.removeEventListener("abort", onOuterAbort);
  }
}
