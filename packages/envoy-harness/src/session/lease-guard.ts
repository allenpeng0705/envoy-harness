/**
 * Session-acquisition retention guard.
 *
 * **The leak this closes.** `PersistedSession.create`/`open` acquire the
 * sidecar write lease and then construct the session. If the caller is
 * cancelled — or throws — between those two steps, the lease is owned by
 * a session nobody holds a reference to. The stale-PID reclaim in
 * `write-lease.ts` eventually cleans it up, but that is a *heuristic
 * second line of defence*: until it fires, a legitimate process is locked
 * out of its own session with `SessionFileBusyError`.
 *
 * **The rule** (ported from codex's `LiveThreadInitGuard`): cleanup must
 * **retain the in-flight acquisition** and wait for it to finish before
 * releasing, rather than dropping the future. Dropping it would let the
 * acquisition complete *after* cleanup ran, leaking the very lease we
 * were trying to release.
 *
 * ```
 * const guard = new SessionInitGuard();
 * const session = await guard.acquire(() => PersistedSession.open(path));
 * // …on success the caller owns it:
 * guard.commit();
 * // …on cancellation / throw:
 * await guard.discard();   // waits for the acquisition, then releases once
 * ```
 */

import type { PersistedSession } from "./persisted-session.js";

export class SessionInitGuard {
  #session: PersistedSession | undefined;
  /** The in-flight acquisition, retained so cleanup can await it. */
  #acquiring: Promise<PersistedSession> | undefined;
  #owned = false;
  #discarded = false;

  /** The session once acquisition has settled. */
  get session(): PersistedSession | undefined {
    return this.#session;
  }

  /**
   * Run `factory` and retain the resulting session.
   *
   * Idempotent per guard: a second call returns the same promise, so a
   * retry cannot acquire a second lease for the same file.
   */
  async acquire(
    factory: () => Promise<PersistedSession>,
  ): Promise<PersistedSession> {
    if (this.#acquiring !== undefined) return this.#acquiring;
    const acquiring = factory().then((session) => {
      this.#session = session;
      return session;
    });
    // Retain BEFORE awaiting: if the caller is cancelled while awaiting,
    // `discard()` must still be able to see and wait for this promise.
    this.#acquiring = acquiring;
    try {
      return await acquiring;
    } catch (err) {
      // The factory failed — nothing was acquired (or it released its own
      // lease on its failure path), so leave the guard clean.
      this.#acquiring = undefined;
      throw err;
    }
  }

  /**
   * Transfer ownership to the caller: after this, {@link discard} is a
   * no-op and the caller is responsible for `session.close()`.
   */
  commit(): void {
    this.#owned = true;
  }

  /**
   * Release anything acquired, exactly once.
   *
   * **Waits for an in-flight acquisition** — that is the whole point. A
   * guard discarded while the acquisition is still running would
   * otherwise release "nothing" and then watch the acquisition install a
   * lease that nobody releases.
   */
  async discard(): Promise<void> {
    if (this.#owned || this.#discarded) return;
    this.#discarded = true;
    const pending = this.#acquiring;
    if (pending === undefined) return;
    // Await the acquisition even if it rejects: we still want to give the
    // session a chance to release whatever it took.
    const session = await pending.catch(() => undefined);
    if (session !== undefined) {
      await session.close().catch(() => undefined);
    }
    this.#session = undefined;
  }
}

/**
 * Run `body` with a guard that discards on throw or abort.
 *
 * A convenience for hosts that wire an `AbortSignal`: the lease cannot
 * leak if the startup is cancelled at any point.
 */
export async function withSessionInitGuard<T>(
  options: { signal?: AbortSignal },
  body: (guard: SessionInitGuard) => Promise<T>,
): Promise<T> {
  const guard = new SessionInitGuard();
  try {
    if (options.signal?.aborted) {
      throw new Error("session acquisition cancelled before it started");
    }
    const result = await body(guard);
    guard.commit();
    return result;
  } catch (err) {
    await guard.discard();
    throw err;
  }
}
