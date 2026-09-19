/**
 * Session-acquisition retention guard — hermetic tests.
 *
 * The leak: `create`/`open` acquire the sidecar write lease and then
 * construct the session. A cancellation or throw in between leaves the
 * lease owned by nobody, locking a legitimate process out of its own
 * session until the stale-PID heuristic fires.
 *
 * The rule under test: cleanup **waits for the in-flight acquisition**
 * before releasing. Dropping the future instead would let the acquisition
 * install a lease *after* cleanup ran — leaking exactly what we were
 * releasing.
 *
 * A fake lease provider drives everything; no disk, no real locks.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PersistedSession,
  SessionInitGuard,
  newSessionId,
  resetWriteLeaseProvider,
  setWriteLeaseProvider,
  withSessionInitGuard,
  type SessionWriteLease,
  type WriteLeaseProvider,
} from "../src/index.js";

afterEach(() => {
  resetWriteLeaseProvider();
});

/** A lease provider that records acquires/releases and can stall. */
function fakeProvider(): {
  provider: WriteLeaseProvider;
  acquired: string[];
  released: string[];
  /** Make the next acquire stall until `releaseGate()` runs. */
  stallNext(): void;
  releaseGate(): void;
} {
  const acquired: string[] = [];
  const released: string[] = [];
  let gate: Promise<void> | undefined;
  let openGate: (() => void) | undefined;

  const provider: WriteLeaseProvider = {
    async acquire(filePath: string): Promise<SessionWriteLease> {
      if (gate !== undefined) await gate;
      acquired.push(filePath);
      let done = false;
      return {
        filePath,
        lockPath: `${filePath}.lock`,
        async release() {
          if (done) return;
          done = true;
          released.push(filePath);
        },
      };
    },
  };

  return {
    provider,
    acquired,
    released,
    stallNext() {
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
    },
    releaseGate() {
      openGate?.();
      gate = undefined;
      openGate = undefined;
    },
  };
}

/** A session-like stand-in so the test never touches a real file. */
function fakeSession(
  onClose: () => void,
): PersistedSession {
  return { id: newSessionId(), close: async () => onClose() } as unknown as PersistedSession;
}

describe("SessionInitGuard", () => {
  it("releases nothing when the guard was never used", async () => {
    const guard = new SessionInitGuard();
    await guard.discard();
    expect(guard.session).toBeUndefined();
  });

  it("does NOT release after commit (the caller owns it)", async () => {
    const guard = new SessionInitGuard();
    const close = vi.fn(async () => undefined);
    await guard.acquire(async () => fakeSession(close));
    guard.commit();
    await guard.discard();
    expect(close).not.toHaveBeenCalled();
  });

  it("releases on discard before commit", async () => {
    const guard = new SessionInitGuard();
    const close = vi.fn(async () => undefined);
    await guard.acquire(async () => fakeSession(close));
    await guard.discard();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("WAITS for an in-flight acquisition before releasing", async () => {
    // The core invariant: discard must not resolve (and must not
    // 'release nothing') while the acquisition is still running.
    const guard = new SessionInitGuard();
    let settleAcquisition: (() => void) | undefined;
    const close = vi.fn(async () => undefined);

    const acquiring = guard.acquire(
      () =>
        new Promise<PersistedSession>((resolve) => {
          settleAcquisition = () => resolve(fakeSession(close));
        }),
    );
    // Abandon the acquiring promise (as a cancelled caller would) and
    // discard while it is still pending.
    void acquiring.catch(() => undefined);
    const discarding = guard.discard();

    // Discard is pending: it retained the acquisition.
    const settledEarly = await Promise.race([
      discarding.then(() => "done" as const),
      Promise.resolve("pending" as const),
    ]);
    expect(settledEarly).toBe("pending");
    expect(close).not.toHaveBeenCalled();

    // Now let the acquisition finish; discard completes and releases once.
    settleAcquisition?.();
    await discarding;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a second discard does not double-release", async () => {
    const guard = new SessionInitGuard();
    const close = vi.fn(async () => undefined);
    await guard.acquire(async () => fakeSession(close));
    await guard.discard();
    await guard.discard();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("retains a single acquisition across repeated acquire() calls", async () => {
    const fake = fakeProvider();
    setWriteLeaseProvider(fake.provider);
    const guard = new SessionInitGuard();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return fakeSession(() => undefined);
    };
    await guard.acquire(factory);
    await guard.acquire(factory);
    expect(calls).toBe(1);
  });

  it("clears the guard when the factory itself throws", async () => {
    const guard = new SessionInitGuard();
    await expect(
      guard.acquire(async () => {
        throw new Error("lease busy");
      }),
    ).rejects.toThrow("lease busy");
    // Nothing was retained, so discard is a clean no-op.
    await expect(guard.discard()).resolves.toBeUndefined();
  });

  it("tolerates a rejected acquisition during discard", async () => {
    const guard = new SessionInitGuard();
    const acquiring = guard.acquire(async () => {
      throw new Error("boom");
    });
    void acquiring.catch(() => undefined);
    await expect(guard.discard()).resolves.toBeUndefined();
  });
});

describe("withSessionInitGuard", () => {
  it("commits on success (no release)", async () => {
    const close = vi.fn(async () => undefined);
    const guard = new SessionInitGuard();
    const result = await withSessionInitGuard({}, async () => {
      await guard.acquire(async () => fakeSession(close));
      return "session";
    });
    expect(result).toBe("session");
    expect(close).not.toHaveBeenCalled();
  });

  it("discards on a throw from the body", async () => {
    let closeCount = 0;
    await expect(
      withSessionInitGuard({}, async (guard) => {
        await guard.acquire(
          async () =>
            ({
              id: newSessionId(),
              close: async () => {
                closeCount += 1;
              },
            }) as unknown as PersistedSession,
        );
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");
    expect(closeCount).toBe(1);
  });

  it("refuses to start on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const body = vi.fn();
    await expect(
      withSessionInitGuard({ signal: controller.signal }, body),
    ).rejects.toThrow(/cancelled/);
    expect(body).not.toHaveBeenCalled();
  });
});

describe("the guard against the real PersistedSession lease", () => {
  it("releases the injected lease exactly once when discarded", async () => {
    const fake = fakeProvider();
    setWriteLeaseProvider(fake.provider);

    // Acquire a real session through the guard, then discard it.
    const dir = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp("/tmp/envoy-lease-"),
    );
    const file = `${dir}/session.jsonl`;
    const guard = new SessionInitGuard();
    await guard.acquire(() =>
      PersistedSession.create({
        id: newSessionId(),
        filePath: file,
        metadata: {
          cwd: dir,
          permissionMode: "read-only",
          startedAt: new Date().toISOString(),
        },
      }),
    );
    expect(fake.acquired).toEqual([file]);

    await guard.discard();
    expect(fake.released).toEqual([file]);
  });
});
