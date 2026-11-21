/**
 * Phase A / Item 5 — the model-facing `ask_user` tool.
 *
 * **Reference:** gap-closure-plan item 5 + deepseek
 * `tool-ask-user` (`ctx.userQuestions.ask(...)`).
 *
 * **What this does:** the model calls `ask_user` when it
 * needs human input ("which option?", "what's the project
 * root?", "paste the error log"). The tool delegates to
 * the `UserQuestionService` (chunk 5.1) and returns the
 * human's answer as a `tool_result` so the model can
 * continue.
 *
 * **Why a tool, not an `Agent.run` option:** tools are
 * how the model expresses "I need help". The model
 * decides WHEN to ask based on its own judgment; making
 * it a tool means the model sees the tool in its tool
 * list and decides dynamically.
 *
 * **Auto-registration:** the `Agent` constructor registers
 * this tool when the host provides a `userQuestions` field
 * (same pattern as `makeTaskTool({ submitter })` and
 * `makeLspTools(manager)`). No `userQuestions` → no
 * `ask_user` tool. The model never sees it.
 *
 * **Result mapping** (the model sees one of these in the
 * `tool_result` block — see
 * [`docs/implementation-plan-chunk-5-2.md`](../../docs/implementation-plan-chunk-5-2.md)
 * for the full table):
 *
 * | Service answer | `isError` | content |
 * |---|---|---|
 * | `{ value: "..." }` (free-form) | `false` | `User answered: <value>` |
 * | `{ value: "no", optionIndex: 1 }` | `false` | `User selected: "no" (option 2)` |
 * | multiline value | `false` | `User answered:\n<value>` |
 * | `cancelled: "no-provider"` | `false` | `no user channel available; please use your default answer` |
 * | `cancelled: "aborted" \| "timeout"` | `true` | `ask_user cancelled by user: <reason>` |
 *
 * **Why `isError: false` for `no-provider`:** the tool ran
 * successfully; there's just no human. The model should
 * treat this as a benign "fall through to your default"
 * condition, not as a tool failure. The "aborted" /
 * "timeout" cases ARE failures (the user actively stopped
 * the question); `isError: true` makes the model treat
 * them as recovery-worthy.
 *
 * **Stability:** additive. New fields on the args are
 * additive; new `cancelledReason` values are additive.
 */

import { z } from "zod";

import type { Tool } from "../tools/types.js";
import type {
  UserQuestionAnswer,
  UserQuestionRequest,
  UserQuestionService,
} from "./user-questions.js";

/** Constructor options for `makeAskUserTool`. */
export interface MakeAskUserToolOptions {
  /**
   * The user-question service. Required — the tool is
   * useless without one. The agent's constructor wires
   * the service here; the tool doesn't construct or
   * own the service.
   */
  service: UserQuestionService;
  /**
   * Wave 3 — late answer for timed mode (e.g. agent.inject).
   */
  onLateAnswer?: (info: {
    pendingId: string;
    prompt: string;
    answer: UserQuestionAnswer;
  }) => void;
}

// ---------------------------------------------------------------------------
// Zod schema + types
// ---------------------------------------------------------------------------

/**
 * The tool's input. Mirrors `UserQuestionRequest` minus
 * `signal` (the agent's `ctx.abortSignal` is used).
 */
const AskUserInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      "The question to ask the human. Keep it short — single-line by default. " +
        "Use `multiline: true` for paste-style input (diffs, error logs).",
    ),
  options: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional fixed-choice options. When set, the human sees a numbered picker. " +
        "The answer carries the chosen option's `value` and 0-based `optionIndex`.",
    ),
  multiple: z
    .boolean()
    .optional()
    .describe(
      "When true, the human may pick more than one of `options`. " +
        "Ignored when `options` is unset. The answer lists every chosen index.",
    ),
  recommendedIndex: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "0-based index into `options` to highlight as recommended. " +
        "Ignored when `options` is unset or the index is out of range.",
    ),
  multiline: z
    .boolean()
    .optional()
    .describe(
      "When true, the human types until they end their input with a sentinel " +
        "(default `\"\"\"` on its own line). Use for paste-style input — diffs, " +
        "error logs, anything the LLM asked the human to paste back.",
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Service-level timeout in milliseconds. When the timeout fires, the " +
        "answer is `cancelled: true, reason: 'timeout'`. Default: no timeout " +
        "(the human may take as long as they want). In mode=timed, -1 keeps " +
        "blocking indefinitely while still returning a pending id.",
    ),
  mode: z
    .enum(["blocking", "timed"])
    .optional()
    .describe(
      "blocking (default): wait for the human. timed: return a pending id " +
        "after timeoutMs (required unless -1) while the question remains answerable; " +
        "a late answer is injected via onLateAnswer / inbox.",
    ),
});

/** Inferred input type for the `ask_user` tool. */
export type AskUserInput = z.infer<typeof AskUserInputSchema>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the `ask_user` tool. The host provides the
 * `UserQuestionService`; the tool calls it on every
 * invocation.
 *
 * @example
 *   const service = createUserQuestionService();
 *   service.registerProvider(createReplStdinProvider());
 *   const tools = new ToolRegistry();
 *   tools.register(makeAskUserTool({ service }));
 *   const agent = new Agent({ ..., tools, userQuestions: service });
 */
let pendingAskSeq = 0;

export function makeAskUserTool(
  options: MakeAskUserToolOptions,
): Tool<typeof AskUserInputSchema> {
  const { service } = options;
  return {
    name: "ask_user",
    description:
      "Ask the human a question and return their answer. Use this when you " +
      "need clarification before proceeding (e.g. which option to pick, what " +
      "the project root is, or to paste back a log / diff). Pass `options` " +
      "for a fixed-choice picker; pass `multiple: true` when more than one option " +
      "applies; pass `multiline: true` for paste-style " +
      "input. mode=timed returns a pending id after timeout while the question " +
      "stays answerable (late answers arrive via inbox). " +
      "The result includes either the human's answer or a " +
      "cancellation reason — read the message and act accordingly.",
    parameters: AskUserInputSchema,
    async execute(args, ctx) {
      const mode = args.mode ?? "blocking";
      const req: UserQuestionRequest = {
        prompt: args.prompt,
        ...(args.options !== undefined ? { options: args.options } : {}),
        ...(args.multiple === true ? { multiple: true } : {}),
        ...(args.recommendedIndex !== undefined
          ? { recommendedIndex: args.recommendedIndex }
          : {}),
        ...(args.multiline !== undefined ? { multiline: args.multiline } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        signal: ctx.abortSignal,
      };

      if (mode === "timed") {
        const pendingId = `ask_pending_${++pendingAskSeq}`;
        // One host ask (no service timeout) raced against a local timer so we
        // never open a second overlapping question for late answers.
        const waitMs =
          args.timeoutMs === undefined || args.timeoutMs < 0
            ? 30_000
            : args.timeoutMs;
        const { timeoutMs: _ignored, ...untimed } = req;
        void _ignored;
        const answerPromise = service.ask(untimed);
        let timedOut = false;
        const answer = await Promise.race([
          answerPromise,
          new Promise<UserQuestionAnswer>((resolve) => {
            const t = setTimeout(() => {
              timedOut = true;
              resolve({
                value: "",
                cancelled: true,
                cancelledReason: "timeout",
              });
            }, waitMs);
            void answerPromise.finally(() => clearTimeout(t));
          }),
        ]);
        if (timedOut) {
          void answerPromise
            .then((late) => {
              if (late.cancelled) return;
              options.onLateAnswer?.({
                pendingId,
                prompt: args.prompt,
                answer: late,
              });
            })
            .catch(() => undefined);
          return {
            content: JSON.stringify({
              ok: true,
              pending: true,
              pendingId,
              prompt: args.prompt,
              message:
                "ask_user timed out waiting; question remains open as " +
                pendingId,
            }),
          };
        }
        const isError =
          answer.cancelled === true &&
          answer.cancelledReason !== "no-provider";
        return {
          content: formatAnswer(args, answer),
          ...(isError ? { isError: true as const } : {}),
        };
      }

      const answer = await service.ask(req);
      const isError =
        answer.cancelled === true &&
        answer.cancelledReason !== "no-provider";
      return {
        content: formatAnswer(args, answer),
        ...(isError ? { isError: true as const } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Format the service's answer into a human-legible string
 * the model reads in the `tool_result` block. The
 * formatting is intentionally consistent: the model can
 * `String#match` the leading token if it wants a stable
 * shape ("User answered:", "User selected:", "ask_user
 * cancelled by user:").
 */
function formatAnswer(
  args: AskUserInput,
  answer: UserQuestionAnswer,
): string {
  if (answer.cancelled) {
    const reason = answer.cancelledReason ?? "aborted";
    if (reason === "no-provider") {
      // Benign: no human in the loop. The model should
      // fall through to its default. NOT an error.
      return "no user channel available; please use your default answer";
    }
    // `aborted` or `timeout` — the user actively
    // stopped (or the timeout fired). The caller in
    // `execute` sets `isError: true` so the model
    // recovers (tries again, picks a different path,
    // etc.).
    return `ask_user cancelled by user: ${reason}`;
  }
  if (args.multiline === true) {
    return `User answered:\n${answer.value}`;
  }
  if (answer.optionIndexes !== undefined && answer.optionIndexes.length > 0) {
    const labels = answer.optionIndexes.map(
      (index) => args.options?.[index] ?? answer.value,
    );
    const shown = labels.map((label) => JSON.stringify(label)).join(", ");
    const numbers = answer.optionIndexes.map((index) => index + 1).join(", ");
    return `User selected: ${shown} (options ${numbers})`;
  }
  if (answer.optionIndex !== undefined) {
    const label = args.options?.[answer.optionIndex] ?? answer.value;
    return `User selected: ${JSON.stringify(label)} (option ${answer.optionIndex + 1})`;
  }
  return `User answered: ${answer.value}`;
}
