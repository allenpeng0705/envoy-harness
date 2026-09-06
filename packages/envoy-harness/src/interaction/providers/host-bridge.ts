/**
 * R4.1 — host-bridged user questions (ACP/TUI async ask).
 *
 * Parks a question on the host via a callback (mirrors
 * `session/request_permission`) so the turn can stay busy while the
 * composer remains free for follow-up queueing. The tool still
 * `await`s the promise; only the host I/O is non-blocking.
 */

import { randomUUID } from "node:crypto";

import type {
  UserQuestionAnswer,
  UserQuestionProvider,
  UserQuestionRequest,
} from "../user-questions.js";

/**
 * Canonical wire shape for ACP/SDK `session/user_question`
 * (server → client). Protocol aliases this as
 * `ProtocolUserQuestionRequest`; the TUI/client reuse it.
 */
export interface HostUserQuestionRequest {
  sessionId: string;
  questionId: string;
  prompt: string;
  options?: ReadonlyArray<string>;
  recommendedIndex?: number;
  multiline?: boolean;
}

/** Canonical wire answer for `session/user_question` (client → server). */
export interface HostUserQuestionAnswer {
  value: string;
  optionIndex?: number;
  cancelled?: boolean;
}

export type HostUserQuestionAsk = (
  req: HostUserQuestionRequest,
) => Promise<UserQuestionAnswer>;

export interface HostBridgeUserQuestionProviderOptions {
  name?: string;
  getSessionId: () => string;
  /** Current prompt's host ask callback; undefined when no host wired. */
  getHostAsk: () => HostUserQuestionAsk | undefined;
}

/**
 * Provider that forwards `ask()` to the ACP/TUI host. When no host
 * callback is set, returns a cancelled `"no-provider"` answer (safe
 * default — same as an unregistered service).
 */
export function createHostBridgeUserQuestionProvider(
  opts: HostBridgeUserQuestionProviderOptions,
): UserQuestionProvider {
  const name = opts.name ?? "acp-host";
  return {
    name,
    async ask(req: UserQuestionRequest): Promise<UserQuestionAnswer> {
      if (req.signal.aborted) {
        return { value: "", cancelled: true, cancelledReason: "aborted" };
      }
      const hostAsk = opts.getHostAsk();
      if (hostAsk === undefined) {
        return {
          value: "",
          cancelled: true,
          cancelledReason: "no-provider",
        };
      }
      const questionId = randomUUID();
      const hostPromise = hostAsk({
        sessionId: opts.getSessionId(),
        questionId,
        prompt: req.prompt,
        ...(req.options !== undefined ? { options: req.options } : {}),
        ...(req.recommendedIndex !== undefined
          ? { recommendedIndex: req.recommendedIndex }
          : {}),
        ...(req.multiline !== undefined ? { multiline: req.multiline } : {}),
      });

      return await new Promise<UserQuestionAnswer>((resolve) => {
        let settled = false;
        const finish = (answer: UserQuestionAnswer): void => {
          if (settled) return;
          settled = true;
          req.signal.removeEventListener("abort", onAbort);
          resolve(answer);
        };
        const onAbort = (): void => {
          finish({ value: "", cancelled: true, cancelledReason: "aborted" });
        };
        if (req.signal.aborted) {
          onAbort();
          return;
        }
        req.signal.addEventListener("abort", onAbort, { once: true });
        void hostPromise.then(
          (answer) => finish(answer),
          () =>
            finish({
              value: "",
              cancelled: true,
              cancelledReason: "aborted",
            }),
        );
      });
    },
  };
}
