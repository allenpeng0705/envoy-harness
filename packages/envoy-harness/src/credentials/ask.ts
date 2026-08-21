/**
 * Phase C / Item 13 — ask-user credentials backend.
 */

import type { UserQuestionService } from "../interaction/user-questions.js";
import type {
  CredentialReference,
  CredentialsProvider,
} from "./types.js";
import { CredentialError } from "./types.js";

export interface AskCredentialsOptions {
  questions: UserQuestionService;
  /** Names this backend is willing to ask for. */
  knownNames?: readonly string[];
}

export function createAskCredentialsProvider(
  options: AskCredentialsOptions,
): CredentialsProvider {
  const known = options.knownNames ?? [];

  return {
    async resolve(ref, opts) {
      if (ref.source !== "ask") {
        throw new CredentialError(
          `ask provider cannot resolve source=${ref.source}`,
          "INVALID",
        );
      }
      const answer = await options.questions.ask({
        prompt: `Enter credential '${ref.name}' (input is not stored in session):`,
        signal: opts.signal,
      });
      if (answer.cancelled || answer.value === "") {
        throw new CredentialError(
          `credential '${ref.name}' cancelled by user`,
          "CANCELLED",
        );
      }
      return answer.value;
    },
    list() {
      return known.map((name) => ({ name, source: "ask" as const }));
    },
  };
}
