/**
 * fetch-http provider tests — stream-with-cap + timeout.
 *
 * **DoS hardening (regression):** before the fix, the provider
 * called `await response.arrayBuffer()` and then sliced,
 * so a 10 GB body would allocate 10 GB before `maxBytes`
 * checked anything. The fix streams via `response.body`
 * and stops reading at the cap.
 */

import { describe, expect, it } from "vitest";

import { createHttpFetchProvider } from "../../src/web/index.js";

function streamingResponse(body: ReadableStream<Uint8Array>, status = 200) {
  return new Response(body, { status });
}

function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

/**
 * A stream that NEVER ends on its own — used to verify the
 * cap check actually cancels the upstream.
 */
function infiniteStream(): ReadableStream<Uint8Array> {
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const tick = (): void => {
        if (cancelled) return;
        try {
          controller.enqueue(new Uint8Array([0x61])); // 'a'
        } catch {
          // After the reader cancels, the controller may
          // throw ERR_INVALID_STATE on enqueue. We swallow
          // and let the stream wind down.
          return;
        }
        queueMicrotask(tick);
      };
      tick();
    },
    cancel() {
      cancelled = true;
    },
  });
}

describe("createHttpFetchProvider — streaming body + cap", () => {
  it("returns full body when under the cap", async () => {
    const body = chunkedStream([
      new TextEncoder().encode("hello "),
      new TextEncoder().encode("world"),
    ]);
    const fetchImpl: typeof fetch = async () => streamingResponse(body);
    const provider = createHttpFetchProvider({ maxBytes: 1024, fetchImpl });
    const result = await provider.fetch({ url: "https://x.test" });
    expect(result.truncated).toBe(false);
    expect(result.body.kind).toBe("text");
    if (result.body.kind === "text") {
      expect(result.body.content).toBe("hello world");
    }
  });

  it("truncates at maxBytes without allocating the full body (DoS hardening)", async () => {
    // 100 chunks of 1 KiB = 100 KiB; cap at 4 KiB. Before
    // the fix, the provider would allocate all 100 KiB in
    // a single Buffer before slicing. After the fix, it
    // stops after 4 chunks.
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 100; i++) {
      chunks.push(new Uint8Array(1024).fill(0x41)); // 1 KiB of 'A'
    }
    const body = chunkedStream(chunks);
    const fetchImpl: typeof fetch = async () => streamingResponse(body);
    const provider = createHttpFetchProvider({ maxBytes: 4 * 1024, fetchImpl });
    const result = await provider.fetch({ url: "https://x.test" });
    expect(result.truncated).toBe(true);
    if (result.body.kind === "text") {
      // Exactly maxBytes worth of 'A'.
      expect(result.body.content.length).toBe(4 * 1024);
      expect(result.body.content).toBe("A".repeat(4 * 1024));
    }
  });

  it("cancels an upstream that never ends (infinite stream)", async () => {
    // The reader MUST cancel the stream at the cap; if it
    // didn't, the promise would never resolve and this test
    // would time out at the vitest level.
    const body = infiniteStream();
    const fetchImpl: typeof fetch = async () => streamingResponse(body);
    const provider = createHttpFetchProvider({ maxBytes: 8, fetchImpl });
    const result = await provider.fetch({ url: "https://x.test" });
    expect(result.truncated).toBe(true);
    if (result.body.kind === "text") {
      expect(result.body.content.length).toBe(8);
    }
  });
});

describe("createHttpFetchProvider — built-in timeout", () => {
  it("aborts when the upstream hangs longer than timeoutMs", async () => {
    // A fetch that never resolves. With a 50ms timeout, the
    // provider must reject instead of hanging.
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal !== undefined && signal !== null) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }
      });
    const provider = createHttpFetchProvider({
      fetchImpl,
      timeoutMs: 50,
    });
    await expect(provider.fetch({ url: "https://x.test" })).rejects.toMatchObject(
      { code: "FETCH_FAILED" },
    );
  });

  it("caller's signal still wins when set", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal !== undefined && signal !== null) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }
      });
    const provider = createHttpFetchProvider({
      fetchImpl,
      timeoutMs: 60_000, // long, so caller's 10ms wins
    });
    await expect(
      provider.fetch({ url: "https://x.test" }, ac.signal),
    ).rejects.toMatchObject({ code: "FETCH_FAILED" });
  });
});
