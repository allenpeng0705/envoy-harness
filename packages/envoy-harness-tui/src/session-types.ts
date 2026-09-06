/**
 * Public types for TuiSession.
 */

import type { EnvoyHarnessClient } from "@envoymesh/envoy-harness-client";
import type {
  HostUserQuestionAnswer,
  HostUserQuestionRequest,
} from "@envoymesh/envoy-harness";

import type { TranscriptFormatOptions, TranscriptLine } from "./transcript.js";

export interface PermissionRequest {
  sessionId: string;
  toolName: string;
  description: string;
  args: unknown;
}

/** R4.1 — structured ask_user / plan-mode question (host wire shape). */
export type UserQuestionRequest = HostUserQuestionRequest;

/** R4.1 — host answer for a parked user question. */
export type UserQuestionAnswer = HostUserQuestionAnswer;

export interface TuiSessionOptions {
  client: EnvoyHarnessClient;
  cwd?: string;
  /** Auto-run permission policy applied when a session starts. */
  initialAutoRun?: "safe-only" | "always-confirm" | "off";
  onTranscript?: (lines: readonly TranscriptLine[]) => void;
  onPermission?: (req: PermissionRequest) => Promise<"allow" | "deny">;
  onUserQuestion?: (
    req: UserQuestionRequest,
  ) => Promise<UserQuestionAnswer>;
  transcriptFormat?: TranscriptFormatOptions;
}
