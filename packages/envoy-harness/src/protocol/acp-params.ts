/**
 * ACP JSON-RPC param parsers (extracted from acp-server for module size).
 */

import { JsonRpcError, JsonRpcErrorCode } from "./types.js";

export function parseRouteInput(params: unknown): {
  capabilityTag: string;
  preferredPeerId?: string;
} {
  if (
    params === null ||
    typeof params !== "object" ||
    typeof (params as { capabilityTag?: unknown }).capabilityTag !== "string" ||
    (params as { capabilityTag: string }).capabilityTag.length === 0
  ) {
    throw new JsonRpcError(
      "capabilityTag required",
      JsonRpcErrorCode.INVALID_PARAMS,
    );
  }
  const preferred =
    (params as { preferredPeerId?: unknown }).preferredPeerId;
  return {
    capabilityTag: (params as { capabilityTag: string }).capabilityTag,
    ...(typeof preferred === "string" ? { preferredPeerId: preferred } : {}),
  };
}

export function parseConnectPeerInput(params: unknown): {
  id: string;
  endpoint: string;
  model?: string;
  capabilities?: readonly string[];
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("id and endpoint required", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const id = (params as { id?: unknown }).id;
  const endpoint = (params as { endpoint?: unknown }).endpoint;
  if (typeof id !== "string" || id.length === 0) {
    throw new JsonRpcError("id required", JsonRpcErrorCode.INVALID_PARAMS);
  }
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new JsonRpcError("endpoint required", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const model = (params as { model?: unknown }).model;
  const capabilities = (params as { capabilities?: unknown }).capabilities;
  return {
    id,
    endpoint,
    ...(typeof model === "string" && model.length > 0 ? { model } : {}),
    ...(Array.isArray(capabilities)
      ? {
          capabilities: capabilities.filter(
            (c): c is string => typeof c === "string" && c.length > 0,
          ),
        }
      : {}),
  };
}

export function assertInitialized(initialized: boolean): void {
  if (!initialized) {
    throw new JsonRpcError(
      "server not initialized; call initialize first",
      JsonRpcErrorCode.INVALID_REQUEST,
    );
  }
}

export function readOptionalCwd(params: unknown): string | undefined {
  if (
    params !== null &&
    typeof params === "object" &&
    typeof (params as { cwd?: unknown }).cwd === "string"
  ) {
    return (params as { cwd: string }).cwd;
  }
  return undefined;
}

export function readSessionId(params: unknown): string {
  if (
    params !== null &&
    typeof params === "object" &&
    typeof (params as { sessionId?: unknown }).sessionId === "string"
  ) {
    return (params as { sessionId: string }).sessionId;
  }
  throw new JsonRpcError("sessionId required", JsonRpcErrorCode.INVALID_PARAMS);
}

export function parsePromptParams(params: unknown): {
  sessionId: string;
  prompt: import("./session-backend.js").ProtocolPromptInput;
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const obj = params as {
    sessionId?: unknown;
    text?: unknown;
    prompt?: unknown;
    content?: unknown;
  };
  if (typeof obj.sessionId !== "string") {
    throw new JsonRpcError(
      "sessionId required",
      JsonRpcErrorCode.INVALID_PARAMS,
    );
  }
  if (Array.isArray(obj.content)) {
    const blocks = parsePromptContentBlocks(obj.content);
    if (blocks.length === 0) {
      throw new JsonRpcError("content required", JsonRpcErrorCode.INVALID_PARAMS);
    }
    return { sessionId: obj.sessionId, prompt: { content: blocks } };
  }
  const text =
    typeof obj.text === "string"
      ? obj.text
      : typeof obj.prompt === "string"
        ? obj.prompt
        : typeof obj.prompt === "object" &&
            obj.prompt !== null &&
            typeof (obj.prompt as { text?: unknown }).text === "string"
          ? (obj.prompt as { text: string }).text
        : undefined;
  if (text === undefined) {
    throw new JsonRpcError("text required", JsonRpcErrorCode.INVALID_PARAMS);
  }
  return { sessionId: obj.sessionId, prompt: { text } };
}

export function parsePromptContentBlocks(
  content: unknown[],
): Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> {
  const out: Array<
    { type: "text"; text: string } | { type: "image"; mimeType: string; data: string }
  > = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown; mimeType?: unknown; data?: unknown };
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
      out.push({ type: "text", text: b.text });
      continue;
    }
    if (
      b.type === "image" &&
      typeof b.mimeType === "string" &&
      typeof b.data === "string" &&
      b.data.length > 0
    ) {
      out.push({ type: "image", mimeType: b.mimeType, data: b.data });
    }
  }
  return out;
}

export function parseSessionCompactParams(params: unknown): {
  sessionId: string;
  keep?: number;
  budget?: number;
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const obj = params as {
    sessionId?: unknown;
    keep?: unknown;
    budget?: unknown;
  };
  const sessionId = readSessionId(params);
  const keep =
    typeof obj.keep === "number" && Number.isFinite(obj.keep)
      ? obj.keep
      : undefined;
  const budget =
    typeof obj.budget === "number" && Number.isFinite(obj.budget)
      ? obj.budget
      : undefined;
  const summarize = (obj as { summarize?: unknown }).summarize === true;
  return {
    sessionId,
    ...(keep !== undefined ? { keep } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(summarize ? { summarize: true } : {}),
  };
}

export function parseSetModelParams(params: unknown): {
  sessionId: string;
  provider: string;
  model?: string;
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const obj = params as {
    sessionId?: unknown;
    provider?: unknown;
    model?: unknown;
  };
  const sessionId = readSessionId(params);
  if (typeof obj.provider !== "string" || obj.provider.length === 0) {
    throw new JsonRpcError("provider required", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const model =
    typeof obj.model === "string" && obj.model.length > 0 ? obj.model : undefined;
  return {
    sessionId,
    provider: obj.provider,
    ...(model !== undefined ? { model } : {}),
  };
}

const SANDBOX_MODES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const APPROVAL_MODES = new Set([
  "unless-trusted",
  "on-request",
  "granular",
  "never",
]);

export function parseSetPolicyParams(params: unknown): {
  sessionId: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approval?: "unless-trusted" | "on-request" | "granular" | "never";
  autoRun?: "always-confirm" | "safe-only" | "off";
  preset?: "safe" | "ask-all" | "approve-all";
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const obj = params as {
    sessionId?: unknown;
    sandbox?: unknown;
    approval?: unknown;
    autoRun?: unknown;
    preset?: unknown;
  };
  const sessionId = readSessionId(params);
  const preset =
    typeof obj.preset === "string" &&
    (obj.preset === "safe" ||
      obj.preset === "ask-all" ||
      obj.preset === "approve-all")
      ? (obj.preset as "safe" | "ask-all" | "approve-all")
      : undefined;
  const sandbox =
    typeof obj.sandbox === "string" && SANDBOX_MODES.has(obj.sandbox)
      ? (obj.sandbox as "read-only" | "workspace-write" | "danger-full-access")
      : undefined;
  const approval =
    typeof obj.approval === "string" && APPROVAL_MODES.has(obj.approval)
      ? (obj.approval as "unless-trusted" | "on-request" | "granular" | "never")
      : undefined;
  const autoRun =
    typeof obj.autoRun === "string" &&
    (obj.autoRun === "always-confirm" ||
      obj.autoRun === "safe-only" ||
      obj.autoRun === "off")
      ? (obj.autoRun as "always-confirm" | "safe-only" | "off")
      : undefined;
  if (
    preset === undefined &&
    sandbox === undefined &&
    approval === undefined &&
    autoRun === undefined
  ) {
    throw new JsonRpcError(
      "preset, sandbox, approval, or autoRun required",
      JsonRpcErrorCode.INVALID_PARAMS,
    );
  }
  return {
    sessionId,
    ...(preset !== undefined ? { preset } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(approval !== undefined ? { approval } : {}),
    ...(autoRun !== undefined ? { autoRun } : {}),
  };
}

export function parseGitDiffParams(params: unknown): {
  sessionId: string;
  staged?: boolean;
  stat?: boolean;
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const obj = params as {
    sessionId?: unknown;
    staged?: unknown;
    stat?: unknown;
  };
  const sessionId = readSessionId(params);
  const staged = obj.staged === true ? true : undefined;
  const stat = obj.stat === true ? true : undefined;
  return {
    sessionId,
    ...(staged !== undefined ? { staged } : {}),
    ...(stat !== undefined ? { stat } : {}),
  };
}

export function parseSessionPlanParams(params: unknown): {
  sessionId: string;
  action: string;
  text?: string;
  reason?: string;
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const obj = params as {
    action?: unknown;
    text?: unknown;
    reason?: unknown;
  };
  const sessionId = readSessionId(params);
  if (typeof obj.action !== "string" || obj.action.length === 0) {
    throw new JsonRpcError("action required", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const text =
    typeof obj.text === "string" && obj.text.length > 0 ? obj.text : undefined;
  const reason =
    typeof obj.reason === "string" && obj.reason.length > 0
      ? obj.reason
      : undefined;
  return {
    sessionId,
    action: obj.action,
    ...(text !== undefined ? { text } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

export function parseSessionSetModeParams(params: unknown): {
  sessionId: string;
  mode?: "default" | "plan" | "review";
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const obj = params as { mode?: unknown };
  const sessionId = readSessionId(params);
  if (obj.mode === undefined) {
    return { sessionId };
  }
  if (
    obj.mode !== "default" &&
    obj.mode !== "plan" &&
    obj.mode !== "review"
  ) {
    throw new JsonRpcError(
      "mode must be default|plan|review",
      JsonRpcErrorCode.INVALID_PARAMS,
    );
  }
  return { sessionId, mode: obj.mode };
}

export function parseSessionMemoryParams(params: unknown): {
  sessionId: string;
  op: "list" | "read" | "add";
  name?: string;
  body?: string;
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const obj = params as {
    op?: unknown;
    name?: unknown;
    body?: unknown;
  };
  const sessionId = readSessionId(params);
  const op = obj.op;
  if (op !== "list" && op !== "read" && op !== "add") {
    throw new JsonRpcError(
      "op must be list|read|add",
      JsonRpcErrorCode.INVALID_PARAMS,
    );
  }
  const name =
    typeof obj.name === "string" && obj.name.length > 0 ? obj.name : undefined;
  const body =
    typeof obj.body === "string" && obj.body.length > 0 ? obj.body : undefined;
  return {
    sessionId,
    op,
    ...(name !== undefined ? { name } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

export function parseSessionReviewParams(params: unknown): {
  sessionId: string;
  staged?: boolean;
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const sessionId = readSessionId(params);
  const staged =
    (params as { staged?: unknown }).staged === true ? true : undefined;
  return {
    sessionId,
    ...(staged !== undefined ? { staged } : {}),
  };
}
