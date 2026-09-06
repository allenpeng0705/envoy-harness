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
      }) => Promise<UserQuestionAnswer>)
    | undefined;
  createdAt: number;
  modelLabel?: string;
  providerLabel?: string;
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
