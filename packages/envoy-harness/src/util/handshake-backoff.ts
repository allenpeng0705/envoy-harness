/**
 * Wave 3/4 — shared handshake reconnect backoff (MCP / peer).
 * Reuses the same exponential+jitter spirit as llm/retry.
 */

export interface HandshakeBackoffOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error("handshake backoff aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retry `fn` with exponential backoff + jitter until it succeeds
 * or `maxRetries` is exhausted.
 */
export async function withHandshakeBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: HandshakeBackoffOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 5;
  const initial = options.initialDelayMs ?? 200;
  const maxDelay = options.maxDelayMs ?? 8_000;
  const jitter = options.jitterRatio ?? 0.2;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries) break;
      const base = Math.min(maxDelay, initial * 2 ** attempt);
      const delay = Math.floor(base * (1 - jitter / 2 + random() * jitter));
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "handshake failed"));
}
