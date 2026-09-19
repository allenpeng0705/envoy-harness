/**
 * Transient-failure retry for model requests.
 *
 * **Why this exists.** envoy had none. A single `429`, `503`, dropped
 * socket, or read timeout ended the turn with a `[model error]` bubble —
 * the single most common way a long agent run dies in practice, because
 * every provider has transient failures and long runs hit them
 * eventually. Everything upstream of this (tool retries, resumable
 * sessions) is worthless if the model call itself is not resilient.
 *
 * **Design, following deepseek-harness's `llm-retry` policy:**
 * - A fixed set of **retryable failure classes**, not "retry anything":
 *   retrying a `400 invalid_request` just burns time and money.
 * - Exponential backoff with jitter, bounded by a ceiling.
 * - A provider-supplied `Retry-After` is honored **verbatim** when it is
 *   within the ceiling. When it exceeds the ceiling we **give up rather
 *   than retry** — otherwise a misbehaving server can park the harness
 *   indefinitely.
 * - The delay is **cancellable**: an aborted turn stops waiting
 *   immediately instead of sleeping out its backoff.
 *
 * Everything is injectable (`sleep`, `random`, `now`) so the whole policy
 * is tested with a fake clock and no timers.
 */

/** The failure classes worth retrying. */
export type RetryableClass =
  | "EMPTY_RESPONSE"
  | "RATE_LIMIT"
  | "SERVER"
  | "TIMEOUT"
  | "TRANSPORT";

export const DEFAULT_RETRYABLE_CLASSES: ReadonlyArray<RetryableClass> = [
  "EMPTY_RESPONSE",
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
];

export interface RetryPolicy {
  /** Maximum retries after the first attempt. `0` disables retrying. */
  readonly maxRetries: number;
  /** First backoff step. */
  readonly initialDelayMs: number;
  /** Backoff ceiling (also the `Retry-After` acceptance ceiling). */
  readonly maxDelayMs: number;
  /** Fraction of the delay randomized, in `[0, 1]`. */
  readonly jitterRatio: number;
  readonly retryableClasses: ReadonlyArray<RetryableClass>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
  retryableClasses: DEFAULT_RETRYABLE_CLASSES,
};

/**
 * A model failure classified for retry purposes.
 *
 * Adapters throw whatever their HTTP layer produces; this normalizes
 * `Error`/`HttpResponse`-ish shapes into a stable class + optional
 * server-requested delay.
 */
export interface ClassifiedFailure {
  readonly class: RetryableClass | "NON_RETRYABLE";
  /** From `Retry-After` (seconds or HTTP-date), when present. */
  readonly retryAfterMs?: number;
  readonly message: string;
}

/** HTTP status codes that mean "try again". */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

/** Node/undici error codes that mean "the network flaked". */
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ABORT_ERR",
]);

/**
 * Parse a `Retry-After` header value (delta-seconds or HTTP-date).
 * Returns `undefined` when absent/unparseable.
 */
export function parseRetryAfterMs(
  value: string | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
}

/**
 * Classify a thrown error for retry purposes.
 *
 * Deliberately conservative: an unclassifiable error is NOT retried, so
 * a persistent bug does not turn into five identical failures before the
 * user sees it.
 */
export function classifyFailure(err: unknown, nowMs: number = Date.now()): ClassifiedFailure {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);

  const asRecord = (err ?? {}) as {
    status?: unknown;
    code?: unknown;
    retryAfter?: unknown;
    response?: { status?: unknown; headers?: Record<string, string> };
    cause?: unknown;
  };

  const status =
    typeof asRecord.status === "number"
      ? asRecord.status
      : typeof asRecord.response?.status === "number"
        ? asRecord.response.status
        : undefined;

  const headerValue =
    typeof asRecord.retryAfter === "string"
      ? asRecord.retryAfter
      : asRecord.response?.headers?.["retry-after"] ??
        asRecord.response?.headers?.["Retry-After"];
  const retryAfterMs = parseRetryAfterMs(headerValue, nowMs);

  if (status !== undefined) {
    if (status === 429) {
      return { class: "RATE_LIMIT", message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    if (RETRYABLE_STATUS.has(status)) {
      return { class: "SERVER", message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    return { class: "NON_RETRYABLE", message };
  }

  const code =
    typeof asRecord.code === "string"
      ? asRecord.code
      : typeof (asRecord.cause as { code?: unknown } | undefined)?.code === "string"
        ? ((asRecord.cause as { code: string }).code)
        : undefined;
  if (code !== undefined && RETRYABLE_CODES.has(code)) {
    return { class: "TRANSPORT", message };
  }

  if (/timed? ?out|timeout/i.test(message)) {
    return { class: "TIMEOUT", message };
  }
  if (/rate ?limit|too many requests|429/i.test(message)) {
    return { class: "RATE_LIMIT", message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (/\b(50[0-9]|52[0-9])\b|server error|bad gateway|service unavailable/i.test(message)) {
    return { class: "SERVER", message };
  }
  if (/econnreset|socket hang up|network|fetch failed/i.test(message)) {
    return { class: "TRANSPORT", message };
  }
  return { class: "NON_RETRYABLE", message };
}

/** Whether the policy retries this class. */
export function isRetryable(
  failure: ClassifiedFailure,
  policy: RetryPolicy,
): boolean {
  if (failure.class === "NON_RETRYABLE") return false;
  return policy.retryableClasses.includes(failure.class);
}

/**
 * Backoff for attempt `retry` (1-based), before jitter.
 *
 * `min(initial * 2^(retry-1), maxDelay)`, with the exponent clamped so a
 * large retry count cannot overflow into `Infinity`.
 */
export function backoffDelayMs(
  retry: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(retry - 1, 0), 1024);
  const base = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs);
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random();
  return Math.min(Math.round(base * jitter), policy.maxDelayMs);
}

export interface RetryDecision {
  readonly retry: true;
  readonly delayMs: number;
  readonly retryNumber: number;
  readonly reason: string;
}

export interface RetryRefusal {
  readonly retry: false;
  readonly reason: string;
}

/**
 * Decide whether and how long to wait before attempt `retryNumber + 1`.
 *
 * `retryNumber` is the number of retries already performed.
 */
export function decideRetry(options: {
  failure: ClassifiedFailure;
  policy: RetryPolicy;
  retryNumber: number;
  random?: () => number;
}): RetryDecision | RetryRefusal {
  const { failure, policy, retryNumber } = options;
  if (policy.maxRetries <= 0) {
    return { retry: false, reason: "retry disabled (maxRetries=0)" };
  }
  if (!isRetryable(failure, policy)) {
    return {
      retry: false,
      reason:
        failure.class === "NON_RETRYABLE"
          ? `not a transient failure: ${failure.message}`
          : `failure class ${failure.class} is not retryable under this policy`,
    };
  }
  if (retryNumber >= policy.maxRetries) {
    return {
      retry: false,
      reason: `retries exhausted (${retryNumber}/${policy.maxRetries})`,
    };
  }

  const requested = failure.retryAfterMs;
  if (requested !== undefined) {
    if (requested > policy.maxDelayMs) {
      // Fail fast instead of sleeping for an unbounded server-chosen
      // delay — a hostile or misconfigured server must not park us.
      return {
        retry: false,
        reason:
          `server asked to retry after ${requested}ms, beyond the ` +
          `${policy.maxDelayMs}ms ceiling`,
      };
    }
    return {
      retry: true,
      delayMs: Math.max(0, requested),
      retryNumber: retryNumber + 1,
      reason: `server-requested Retry-After ${requested}ms (honored verbatim)`,
    };
  }

  return {
    retry: true,
    delayMs: backoffDelayMs(retryNumber + 1, policy, options.random),
    retryNumber: retryNumber + 1,
    reason: `transient ${failure.class}`,
  };
}

/** Cancellable sleep. Resolves `false` when aborted. */
export async function cancellableDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  if (delayMs <= 0) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `attempt` with retry-on-transient-failure.
 *
 * The abort signal is honored both before and during the backoff, so a
 * cancelled turn never sits out a retry delay.
 */
export async function withRetry<T>(options: {
  attempt: () => Promise<T>;
  policy: RetryPolicy;
  signal: AbortSignal;
  /** Called before each wait, for tracing. */
  onRetry?: (decision: RetryDecision, failure: ClassifiedFailure) => void;
  /** Called when a retry is refused, for tracing. */
  onGiveUp?: (refusal: RetryRefusal, failure: ClassifiedFailure) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  random?: () => number;
  now?: () => number;
}): Promise<T> {
  const policy = options.policy;
  const sleep = options.sleep ?? cancellableDelay;
  const now = options.now ?? (() => Date.now());
  let retryNumber = 0;

  for (;;) {
    try {
      return await options.attempt();
    } catch (err) {
      const failure = classifyFailure(err, now());
      if (options.signal.aborted) {
        // A cancelled retry is still a retry that did not happen —
        // report it so the trace shows why the turn stopped.
        options.onGiveUp?.(
          { retry: false, reason: "turn aborted before retrying" },
          failure,
        );
        throw err;
      }
      const decision = decideRetry({
        failure,
        policy,
        retryNumber,
        ...(options.random !== undefined ? { random: options.random } : {}),
      });
      if (!decision.retry) {
        options.onGiveUp?.(decision, failure);
        throw err;
      }
      options.onRetry?.(decision, failure);
      retryNumber = decision.retryNumber;
      const completed = await sleep(decision.delayMs, options.signal);
      if (!completed) {
        // Cancelled *during* the backoff. Report it: without this the
        // "why did the turn stop" question has no answer on the trace or
        // in the session diagnostics, even though we had already
        // announced the retry we then abandoned.
        options.onGiveUp?.(
          { retry: false, reason: "turn aborted during backoff" },
          failure,
        );
        throw err;
      }
    }
  }
}
