/**
 * Phase A / Item 5 — public surface for the user-question
 * service. Re-exported by the package entry point so
 * consumers (Tauri host, mesh adapter) can register their
 * own providers.
 */

export {
  createUserQuestionService,
  type UserQuestionAnswer,
  type UserQuestionProvider,
  type UserQuestionRequest,
  type UserQuestionService,
} from "./user-questions.js";

export {
  createReplStdinProvider,
  DEFAULT_MULTILINE_SENTINEL,
  type ReplStdinProviderOptions,
} from "./providers/repl-stdin.js";
