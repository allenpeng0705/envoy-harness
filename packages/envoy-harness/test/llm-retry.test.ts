/**
 * Model-request retry policy — hermetic tests.
 *
 * envoy had no retry at all: a single 429/503/timeout ended the turn.
 * These pin the classification, the backoff math, the "never retry a
 * non-transient failure" rule, the server-`Retry-After` ceiling, and
 * cancellation during the wait. Everything uses an injected clock and
 * sleep — no real timers, no network.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  classifyFailure,
  decideRetry,
  isRetryable,
  parseRetryAfterMs,
  withRetry,
  type RetryPolicy,
} from "../src/index.js";

const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY };

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("parses an HTTP-date relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
  });

  it("returns undefined for absent or unparseable values", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});

describe("classifyFailure", () => {
  it("classifies 429 as RATE_LIMIT", () => {
    expect(classifyFailure({ status: 429, message: "slow down" })).toMatchObject({
      class: "RATE_LIMIT",
    });
  });

  it("classifies 5xx as SERVER", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyFailure({ status }).class).toBe("SERVER");
    }
  });

  it("classifies 4xx (except 429) as NON_RETRYABLE", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyFailure({ status }).class).toBe("NON_RETRYABLE");
    }
  });

  it("classifies transient socket codes as TRANSPORT", () => {
    expect(classifyFailure({ code: "ECONNRESET" }).class).toBe("TRANSPORT");
    expect(classifyFailure({ code: "UND_ERR_SOCKET" }).class).toBe("TRANSPORT");
  });

  it("classifies a nested cause code", () => {
    expect(classifyFailure({ cause: { code: "ETIMEDOUT" } }).class).toBe("TRANSPORT");
  });

  it("classifies timeouts by message", () => {
    expect(classifyFailure(new Error("request timed out")).class).toBe("TIMEOUT");
  });

  it("does NOT retry an unclassifiable error", () => {
    // Conservative on purpose: a persistent bug must surface, not be
    // retried five times before the user sees it.
    expect(classifyFailure(new Error("something went wrong")).class).toBe(
      "NON_RETRYABLE",
    );
  });

  it("carries a Retry-After header through", () => {
    const failure = classifyFailure({
      status: 429,
      response: { status: 429, headers: { "retry-after": "3" } },
    });
    expect(failure.class).toBe("RATE_LIMIT");
    expect(failure.retryAfterMs).toBe(3000);
  });
});

describe("isRetryable", () => {
  it("honors the policy's class list", () => {
    const narrow: RetryPolicy = { ...policy, retryableClasses: ["SERVER"] };
    expect(isRetryable({ class: "SERVER", message: "" }, narrow)).toBe(true);
    expect(isRetryable({ class: "RATE_LIMIT", message: "" }, narrow)).toBe(false);
    expect(isRetryable({ class: "NON_RETRYABLE", message: "" }, policy)).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("doubles per attempt and respects the ceiling", () => {
    // random()=0.5 → jitter factor exactly 1.
    const mid = () => 0.5;
    expect(backoffDelayMs(1, policy, mid)).toBe(500);
    expect(backoffDelayMs(2, policy, mid)).toBe(1000);
    expect(backoffDelayMs(3, policy, mid)).toBe(2000);
    expect(backoffDelayMs(4, policy, mid)).toBe(4000);
    expect(backoffDelayMs(5, policy, mid)).toBe(8000);
    // 16000 would exceed the 10s ceiling.
    expect(backoffDelayMs(6, policy, mid)).toBe(10_000);
    expect(backoffDelayMs(50, policy, mid)).toBe(10_000);
  });

  it("applies jitter within the configured band", () => {
    // 500ms base, jitterRatio 0.1 → [450, 550]. The ceiling is 10s, so
    // the upper jitter is not clamped at this step.
    expect(backoffDelayMs(1, policy, () => 0)).toBe(450);
    expect(backoffDelayMs(1, policy, () => 1)).toBe(550);
  });

  it("never exceeds the ceiling even with positive jitter", () => {
    for (const r of [0, 0.5, 1]) {
      expect(backoffDelayMs(20, policy, () => r)).toBeLessThanOrEqual(policy.maxDelayMs);
    }
  });
});

describe("decideRetry", () => {
  const server: Parameters<typeof decideRetry>[0]["failure"] = {
    class: "SERVER",
    message: "503",
  };

  it("retries a transient failure with a backoff delay", () => {
    const decision = decideRetry({
      failure: server,
      policy,
      retryNumber: 0,
      random: () => 0.5,
    });
    expect(decision.retry).toBe(true);
    if (decision.retry) expect(decision.delayMs).toBe(500);
  });

  it("refuses a non-transient failure", () => {
    const decision = decideRetry({
      failure: { class: "NON_RETRYABLE", message: "400 bad request" },
      policy,
      retryNumber: 0,
    });
    expect(decision.retry).toBe(false);
  });

  it("stops when retries are exhausted", () => {
    const decision = decideRetry({
      failure: server,
      policy,
      retryNumber: policy.maxRetries,
    });
    expect(decision.retry).toBe(false);
    if (!decision.retry) expect(decision.reason).toContain("exhausted");
  });

  it("honors a server Retry-After verbatim (no jitter)", () => {
    const decision = decideRetry({
      failure: { class: "RATE_LIMIT", message: "429", retryAfterMs: 2500 },
      policy,
      retryNumber: 0,
      random: () => 0, // would jitter a computed delay; must not be used
    });
    expect(decision.retry).toBe(true);
    if (decision.retry) expect(decision.delayMs).toBe(2500);
  });

  it("GIVES UP rather than sleeping past the ceiling", () => {
    // A hostile/misconfigured server must not be able to park the harness
    // for an unbounded time.
    const decision = decideRetry({
      failure: {
        class: "RATE_LIMIT",
        message: "429",
        retryAfterMs: policy.maxDelayMs + 1,
      },
      policy,
      retryNumber: 0,
    });
    expect(decision.retry).toBe(false);
    if (!decision.retry) expect(decision.reason).toContain("ceiling");
  });

  it("is disabled by maxRetries=0", () => {
    const decision = decideRetry({
      failure: server,
      policy: { ...policy, maxRetries: 0 },
      retryNumber: 0,
    });
    expect(decision.retry).toBe(false);
  });
});

describe("withRetry", () => {
  const noSleep = async () => true;

  it("returns the first success without retrying", async () => {
    const attempt = vi.fn(async () => "ok");
    const result = await withRetry({
      attempt,
      policy,
      signal: new AbortController().signal,
      sleep: noSleep,
    });
    expect(result).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure until it succeeds", async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const result = await withRetry({
      attempt: async () => {
        calls += 1;
        if (calls < 3) throw { status: 503, message: "unavailable" };
        return "recovered";
      },
      policy,
      signal: new AbortController().signal,
      sleep: noSleep,
      random: () => 0.5,
      onRetry,
    });
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ retryNumber: 1, delayMs: 500 });
    expect(onRetry.mock.calls[1]?.[0]).toMatchObject({ retryNumber: 2, delayMs: 1000 });
  });

  it("does NOT retry a non-transient failure", async () => {
    const attempt = vi.fn(async () => {
      throw { status: 400, message: "invalid request" };
    });
    const onGiveUp = vi.fn();
    await expect(
      withRetry({
        attempt,
        policy,
        signal: new AbortController().signal,
        sleep: noSleep,
        onGiveUp,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it("reports onGiveUp when the cancel lands during the backoff", async () => {
    // The sleep is where a long backoff actually waits, so this is the
    // window a user's Ctrl-C lands in. Without an `onGiveUp` here the
    // trace/diagnostics say a retry was announced and then nothing.
    const attempt = vi.fn(async () => {
      throw { status: 500, message: "boom" };
    });
    const onRetry = vi.fn();
    const onGiveUp = vi.fn();
    await expect(
      withRetry({
        attempt,
        policy,
        signal: new AbortController().signal,
        // Simulate "aborted while sleeping": report not-completed.
        sleep: async () => false,
        onRetry,
        onGiveUp,
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp.mock.calls[0]?.[0]).toMatchObject({
      retry: false,
      reason: "turn aborted during backoff",
    });
  });

  it("gives up after maxRetries and rethrows the last error", async () => {
    let calls = 0;
    const attempt = async () => {
      calls += 1;
      throw { status: 500, message: "boom" };
    };
    await expect(
      withRetry({
        attempt,
        policy: { ...policy, maxRetries: 2 },
        signal: new AbortController().signal,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ status: 500 });
    // 1 initial + 2 retries
    expect(calls).toBe(3);
  });

  it("stops immediately when the turn is aborted", async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => {
      throw { status: 503, message: "unavailable" };
    });
    controller.abort();
    await expect(
      withRetry({
        attempt,
        policy,
        signal: controller.signal,
        sleep: noSleep,
      }),
    ).rejects.toBeDefined();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not sleep out the backoff when aborted mid-wait", async () => {
    const controller = new AbortController();
    let calls = 0;
    const sleep = vi.fn(async () => {
      // The wait is cancelled: return false, like cancellableDelay does.
      controller.abort();
      return false;
    });
    await expect(
      withRetry({
        attempt: async () => {
          calls += 1;
          throw { status: 500, message: "boom" };
        },
        policy,
        signal: controller.signal,
        sleep,
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(calls).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("honors a server Retry-After for the wait duration", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry({
      attempt: async () => {
        calls += 1;
        if (calls === 1) {
          throw {
            status: 429,
            message: "slow down",
            response: { status: 429, headers: { "retry-after": "2" } },
          };
        }
        return "ok";
      },
      policy,
      signal: new AbortController().signal,
      sleep: async (ms) => {
        delays.push(ms);
        return true;
      },
    });
    expect(delays).toEqual([2000]);
  });
});
