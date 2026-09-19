/**
 * Host-bridged permission + user-question wiring for the agent session
 * backend (R4.1 review extraction).
 */

import type { Agent } from "../agent.js";
import { HookRegistry } from "../hooks/index.js";
import {
  createUserQuestionService,
  type UserQuestionAnswer,
  type UserQuestionService,
} from "../interaction/user-questions.js";
import { createHostBridgeUserQuestionProvider } from "../interaction/providers/host-bridge.js";
import {
  shouldAskUnderAutoRun,
  type AutoRunPolicy,
} from "../permissions/auto-run.js";
import { SessionInitGuard } from "../session/lease-guard.js";
import type { PersistedSession } from "../session/persisted-session.js";
import type { AskHandler } from "../types.js";
import { installToolPermissionAskHook } from "./permission-hook.js";

export interface LiveSession {
  agent: Agent;
  abort: AbortController | undefined;
  /** Resolves pending host permission waits so cancel can unblock. */
  permissionWait:
    | {
        resolve: (decision: "allow" | "deny") => void;
      }
    | undefined;
  requestPermission:
    | ((req: {
        sessionId: string;
        toolName: string;
        description: string;
        args: unknown;
      }) => Promise<"allow" | "deny">)
    | undefined;
  /**
   * R4.1 — pending user-question waiters (questionId → resolve).
   * Cancel / abort resolves all with a cancelled answer.
   */
  userQuestionWaits: Map<
    string,
    { resolve: (answer: UserQuestionAnswer) => void }
  >;
  requestUserQuestion:
    | ((req: {
        sessionId: string;
        questionId: string;
        prompt: string;
        options?: ReadonlyArray<string>;
        recommendedIndex?: number;
        multiline?: boolean;
        multiple?: boolean;
      }) => Promise<UserQuestionAnswer>)
    | undefined;
  createdAt: number;
  modelLabel?: string;
  providerLabel?: string;
  /**
   * Session-level API base URL override.
   * `undefined` = inherit from host `getConfig` / CLI;
   * `null` = cleared via `set_model` (use env defaults);
   * string = explicit override.
   */
  baseUrlLabel?: string | null;
  /** Session-level auto-run permission policy (TUI / ACP hosts). */
  autoRun?: AutoRunPolicy;
}

export function cancelPendingUserQuestions(live: LiveSession): void {
  for (const [, waiter] of live.userQuestionWaits) {
    waiter.resolve({
      value: "",
      cancelled: true,
      cancelledReason: "aborted",
    });
  }
  live.userQuestionWaits.clear();
}

export function abortAsUserQuestionCancel(
  signal: AbortSignal,
): Promise<UserQuestionAnswer> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ value: "", cancelled: true, cancelledReason: "aborted" });
      return;
    }
    signal.addEventListener(
      "abort",
      () =>
        resolve({ value: "", cancelled: true, cancelledReason: "aborted" }),
      { once: true },
    );
  });
}

export function abortAsDeny(signal: AbortSignal): Promise<"deny"> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("deny");
      return;
    }
    signal.addEventListener("abort", () => resolve("deny"), { once: true });
  });
}

export function wireHostUserQuestions(
  live: LiveSession,
  sessionId: string,
): UserQuestionService {
  const userQuestions = createUserQuestionService();
  userQuestions.registerProvider(
    createHostBridgeUserQuestionProvider({
      name: "acp-host",
      getSessionId: () => sessionId,
      getHostAsk: () => {
        const host = live.requestUserQuestion;
        if (host === undefined) return undefined;
        return async (req) => {
          if (live.abort?.signal.aborted) {
            return {
              value: "",
              cancelled: true,
              cancelledReason: "aborted",
            };
          }
          const hostPromise = host(req);
          const wrapped = new Promise<UserQuestionAnswer>((resolve) => {
            live.userQuestionWaits.set(req.questionId, { resolve });
            void hostPromise.then(
              (answer) => {
                live.userQuestionWaits.delete(req.questionId);
                resolve(answer);
              },
              () => {
                live.userQuestionWaits.delete(req.questionId);
                resolve({
                  value: "",
                  cancelled: true,
                  cancelledReason: "aborted",
                });
              },
            );
          });
          const signal = live.abort?.signal;
          if (signal === undefined) return await wrapped;
          return await Promise.race([
            wrapped,
            abortAsUserQuestionCancel(signal),
          ]);
        };
      },
    }),
  );
  return userQuestions;
}

export function createHostAskHandler(
  live: LiveSession,
  sessionId: string,
): AskHandler {
  return async (req) => {
    if (req.signal.aborted) {
      return { kind: "deny", reason: "cancelled" };
    }
    const hostAsk =
      live.requestPermission?.({
        sessionId,
        toolName: req.tool,
        description: req.question,
        args: req.args,
      }) ?? Promise.resolve<"deny">("deny");

    const wrappedHost = new Promise<"allow" | "deny">((resolve) => {
      live.permissionWait = { resolve };
      void hostAsk.then(
        (d) => {
          live.permissionWait = undefined;
          resolve(d);
        },
        () => {
          live.permissionWait = undefined;
          resolve("deny");
        },
      );
    });

    const decision = await Promise.race([
      wrappedHost,
      abortAsDeny(req.signal),
    ]);
    live.permissionWait = undefined;
    if (req.signal.aborted || decision !== "allow") {
      return {
        kind: "deny",
        reason: req.signal.aborted ? "cancelled" : "host denied",
      };
    }
    return { kind: "allow" };
  };
}

export function emptyLiveSession(): LiveSession {
  return {
    agent: undefined as unknown as Agent,
    abort: undefined,
    permissionWait: undefined,
    requestPermission: undefined,
    userQuestionWaits: new Map(),
    requestUserQuestion: undefined,
    createdAt: Date.now(),
  };
}

/** Install permission ask hook after the agent is created. */
export function installLivePermissionHook(
  live: LiveSession,
  shouldAskTool: ((toolName: string, args?: unknown) => boolean) | undefined,
): void {
  const hooks = live.agent.hooks ?? new HookRegistry();
  installToolPermissionAskHook(hooks, {
    shouldAsk: (toolName, args) => {
      const autoRun = shouldAskUnderAutoRun(live.autoRun, toolName, args);
      if (autoRun !== undefined) return autoRun;
      return shouldAskTool?.(toolName, args) ?? true;
    },
  });
}


/** Default bound on session acquisition. `0` disables it. */
export const DEFAULT_SESSION_ACQUIRE_TIMEOUT_MS = 30_000;

/**
 * Resolve `true` when `promise` settles within `ms`.
 *
 * Never rejects: the caller still awaits the original promise, so a
 * rejection is reported once, by the real await.
 */
export async function settledWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => false,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Acquire a persisted session under a bounded wait, without leaking the
 * write lease when the wait expires.
 *
 * **The leak this prevents.** On timeout the naive move is to abandon the
 * acquisition and report failure. But the acquisition is still running,
 * and it will install a write lease on the session file when it finishes —
 * a lease nobody holds a reference to and nobody releases. The next
 * process to `--resume` that session then gets `SessionFileBusyError`
 * until the stale-PID heuristic reclaims it.
 *
 * `SessionInitGuard` exists exactly for this: `discard()` **awaits** the
 * in-flight acquisition and then closes whatever it produced. The guard is
 * kept alive (rather than dropped) precisely so the release still happens
 * after we have returned failure to the caller.
 */
export async function acquirePersistedSession(
  factory: () => Promise<PersistedSession>,
  timeoutMs: number,
): Promise<PersistedSession> {
  const guard = new SessionInitGuard();
  const acquiring = guard.acquire(factory);
  if (timeoutMs > 0) {
    const timedOut = await settledWithin(acquiring, timeoutMs);
    if (timedOut) {
      // Deliberately not awaited: the caller must fail fast, while the
      // guard keeps the release path alive in the background.
      void guard.discard();
      throw new Error(`session acquisition timed out after ${timeoutMs}ms`);
    }
  }
  const session = await acquiring;
  guard.commit();
  return session;
}

/**
 * Stop using a live session and release what it holds.
 *
 * Aborting alone is not enough for a persisted session: `Agent` keeps a
 * `PersistedSession`, which holds an **exclusive write lease** on its
 * JSONL file plus a pending batch-write timer. Dropping the reference
 * without `close()` leaves the file locked for the life of the host
 * process, so a later `--resume` (or another ACP client) fails with
 * `SessionFileBusyError` until the stale-PID heuristic reclaims it. The
 * ACP host is long-lived and evicts on a size cap, so the leak is
 * guaranteed to fire, not hypothetical.
 *
 * `close()` flushes first, so the evicted session's transcript is still
 * durable. Failures are swallowed: the caller is already tearing the
 * session down and has no meaningful recovery.
 */
export function retireLiveSession(
  doomed: LiveSession | undefined,
  reason: string,
): void {
  if (doomed === undefined) return;
  doomed.abort?.abort();
  doomed.permissionWait?.resolve("deny");
  cancelPendingUserQuestions(doomed);
  doomed.agent.abort(reason);
  // `createAgent` is host-supplied and tests pass minimal doubles, so
  // probe rather than assume the full `Agent` surface.
  if (typeof doomed.agent.getSession !== "function") return;
  const session = doomed.agent.getSession();
  if (session.close !== undefined) {
    void session.close().catch(() => undefined);
  }
}
