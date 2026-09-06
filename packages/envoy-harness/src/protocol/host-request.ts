/**
 * Shared host-bridge request helpers for ACP + SDK servers (R4.1 review).
 */

import type { JsonRpcConnection } from "./connection.js";
import type {
  ProtocolPermissionDecision,
  ProtocolUserQuestionAnswer,
  ProtocolUserQuestionRequest,
} from "./session-backend.js";

const HOST_REQUEST_TIMEOUT_MS = 5 * 60_000;

/** Defensive parse of `session/request_permission` host response. */
export async function requestHostPermission(
  connection: JsonRpcConnection,
  req: {
    sessionId: string;
    toolName: string;
    description: string;
    args: unknown;
  },
): Promise<ProtocolPermissionDecision> {
  const raw = await connection.request(
    "session/request_permission",
    {
      sessionId: req.sessionId,
      toolName: req.toolName,
      description: req.description,
      args: req.args,
    },
    HOST_REQUEST_TIMEOUT_MS,
  );
  const decision =
    typeof raw === "object" &&
    raw !== null &&
    "decision" in raw &&
    typeof (raw as { decision: unknown }).decision === "string"
      ? (raw as { decision: string }).decision
      : undefined;
  return decision === "allow" ? "allow" : "deny";
}

/** Defensive parse of `session/user_question` host response. */
export async function requestHostUserQuestion(
  connection: JsonRpcConnection,
  req: ProtocolUserQuestionRequest,
): Promise<ProtocolUserQuestionAnswer> {
  const raw = await connection.request(
    "session/user_question",
    {
      sessionId: req.sessionId,
      questionId: req.questionId,
      prompt: req.prompt,
      ...(req.options !== undefined ? { options: [...req.options] } : {}),
      ...(req.recommendedIndex !== undefined
        ? { recommendedIndex: req.recommendedIndex }
        : {}),
      ...(req.multiline !== undefined ? { multiline: req.multiline } : {}),
    },
    HOST_REQUEST_TIMEOUT_MS,
  );
  if (typeof raw !== "object" || raw === null) {
    return { value: "", cancelled: true };
  }
  const obj = raw as Record<string, unknown>;
  return {
    value: typeof obj.value === "string" ? obj.value : "",
    ...(typeof obj.optionIndex === "number"
      ? { optionIndex: obj.optionIndex }
      : {}),
    cancelled: obj.cancelled === true,
  };
}
