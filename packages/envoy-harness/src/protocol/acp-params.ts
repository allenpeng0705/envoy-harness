/**
 * ACP JSON-RPC param parsers (extracted from acp-server for module size).
 */

import { isAbsolute } from "node:path";

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
  baseUrl?: string;
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const obj = params as {
    sessionId?: unknown;
    provider?: unknown;
    model?: unknown;
    baseUrl?: unknown;
  };
  const sessionId = readSessionId(params);
  if (typeof obj.provider !== "string" || obj.provider.length === 0) {
    throw new JsonRpcError("provider required", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const model =
    typeof obj.model === "string" && obj.model.length > 0 ? obj.model : undefined;
  const baseUrl =
    typeof obj.baseUrl === "string" && obj.baseUrl.length > 0
      ? obj.baseUrl
      : undefined;
  return {
    sessionId,
    provider: obj.provider,
    ...(model !== undefined ? { model } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
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

const DECISION_MODES = new Set(["off", "shadow", "enforce"]);
const DECISION_BACKENDS = new Set(["null", "laya-http", "jev", "onnx"]);

function readOptionalFiniteNumber(
  value: unknown,
  opts?: { min?: number; max?: number },
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (opts?.min !== undefined && value < opts.min) return undefined;
  if (opts?.max !== undefined && value > opts.max) return undefined;
  return value;
}

function parseDecisionSafeAuto(raw: unknown):
  | {
      enabled?: boolean;
      tools?: string[];
      destructiveThreshold?: number;
      minConfidence?: number;
      honorDeny?: boolean;
    }
  | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const sa = raw as Record<string, unknown>;
  const tools = Array.isArray(sa["tools"])
    ? sa["tools"].filter(
        (t): t is string => typeof t === "string" && t.length > 0,
      )
    : undefined;
  const out = {
    ...(typeof sa["enabled"] === "boolean" ? { enabled: sa["enabled"] } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(readOptionalFiniteNumber(sa["destructiveThreshold"], {
      min: 0,
      max: 1,
    }) !== undefined
      ? {
          destructiveThreshold: readOptionalFiniteNumber(
            sa["destructiveThreshold"],
            { min: 0, max: 1 },
          )!,
        }
      : {}),
    ...(readOptionalFiniteNumber(sa["minConfidence"], { min: 0, max: 1 }) !==
    undefined
      ? {
          minConfidence: readOptionalFiniteNumber(sa["minConfidence"], {
            min: 0,
            max: 1,
          })!,
        }
      : {}),
    ...(typeof sa["honorDeny"] === "boolean"
      ? { honorDeny: sa["honorDeny"] }
      : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseDecisionModelProfile(raw: unknown):
  | {
      id: string;
      provider: string;
      model: string;
      baseUrl?: string;
      description?: string;
      toolsOk?: boolean;
    }
  | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const p = raw as Record<string, unknown>;
  if (
    typeof p["id"] !== "string" ||
    p["id"].length === 0 ||
    typeof p["provider"] !== "string" ||
    p["provider"].length === 0 ||
    typeof p["model"] !== "string" ||
    p["model"].length === 0
  ) {
    return undefined;
  }
  return {
    id: p["id"],
    provider: p["provider"],
    model: p["model"],
    ...(typeof p["baseUrl"] === "string" && p["baseUrl"].length > 0
      ? { baseUrl: p["baseUrl"] }
      : {}),
    ...(typeof p["description"] === "string"
      ? { description: p["description"] }
      : {}),
    ...(typeof p["toolsOk"] === "boolean" ? { toolsOk: p["toolsOk"] } : {}),
  };
}

function parseDecisionModelRouter(raw: unknown):
  | {
      enabled?: boolean;
      timeoutMs?: number;
      minConfidence?: number;
      defaultProfile?: string;
      profiles?: Array<{
        id: string;
        provider: string;
        model: string;
        baseUrl?: string;
        description?: string;
        toolsOk?: boolean;
      }>;
    }
  | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const mr = raw as Record<string, unknown>;
  const profiles = Array.isArray(mr["profiles"])
    ? mr["profiles"]
        .map(parseDecisionModelProfile)
        .filter((p): p is NonNullable<typeof p> => p !== undefined)
    : undefined;
  const timeoutMs = readOptionalFiniteNumber(mr["timeoutMs"], { min: 1 });
  const minConfidence = readOptionalFiniteNumber(mr["minConfidence"], {
    min: 0,
    max: 1,
  });
  const out = {
    ...(typeof mr["enabled"] === "boolean" ? { enabled: mr["enabled"] } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs: Math.floor(timeoutMs) } : {}),
    ...(minConfidence !== undefined ? { minConfidence } : {}),
    ...(typeof mr["defaultProfile"] === "string" &&
    mr["defaultProfile"].length > 0
      ? { defaultProfile: mr["defaultProfile"] }
      : {}),
    ...(profiles !== undefined ? { profiles } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseDecisionInputGuard(raw: unknown):
  | {
      enabled?: boolean;
      timeoutMs?: number;
      injectionThreshold?: number;
      harmScoreBlock?: number;
      honorBlock?: boolean;
    }
  | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const ig = raw as Record<string, unknown>;
  const timeoutMs = readOptionalFiniteNumber(ig["timeoutMs"], { min: 1 });
  const injectionThreshold = readOptionalFiniteNumber(
    ig["injectionThreshold"],
    { min: 0, max: 1 },
  );
  const harmScoreBlock = readOptionalFiniteNumber(ig["harmScoreBlock"], {
    min: 0,
    max: 10,
  });
  const out = {
    ...(typeof ig["enabled"] === "boolean" ? { enabled: ig["enabled"] } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs: Math.floor(timeoutMs) } : {}),
    ...(injectionThreshold !== undefined ? { injectionThreshold } : {}),
    ...(harmScoreBlock !== undefined ? { harmScoreBlock } : {}),
    ...(typeof ig["honorBlock"] === "boolean"
      ? { honorBlock: ig["honorBlock"] }
      : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseSetDecisionParams(params: unknown): {
  sessionId: string;
  mode?: "off" | "shadow" | "enforce";
  backend?: "null" | "laya-http" | "jev" | "onnx";
  endpoint?: string;
  timeoutMs?: number;
  apiKeyEnv?: string;
  model?: string;
  safeAuto?: {
    enabled?: boolean;
    tools?: string[];
    destructiveThreshold?: number;
    minConfidence?: number;
    honorDeny?: boolean;
  };
  modelRouter?: {
    enabled?: boolean;
    timeoutMs?: number;
    minConfidence?: number;
    defaultProfile?: string;
    profiles?: Array<{
      id: string;
      provider: string;
      model: string;
      baseUrl?: string;
      description?: string;
      toolsOk?: boolean;
    }>;
  };
  inputGuard?: {
    enabled?: boolean;
    timeoutMs?: number;
    injectionThreshold?: number;
    harmScoreBlock?: number;
    honorBlock?: boolean;
  };
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const obj = params as {
    mode?: unknown;
    backend?: unknown;
    endpoint?: unknown;
    timeoutMs?: unknown;
    apiKeyEnv?: unknown;
    model?: unknown;
    safeAuto?: unknown;
    modelRouter?: unknown;
    inputGuard?: unknown;
  };
  const sessionId = readSessionId(params);
  const mode =
    typeof obj.mode === "string" && DECISION_MODES.has(obj.mode)
      ? (obj.mode as "off" | "shadow" | "enforce")
      : undefined;
  const backend =
    typeof obj.backend === "string" && DECISION_BACKENDS.has(obj.backend)
      ? (obj.backend as "null" | "laya-http" | "jev" | "onnx")
      : undefined;
  const endpoint =
    typeof obj.endpoint === "string" && obj.endpoint.length > 0
      ? obj.endpoint
      : undefined;
  const timeoutMsRaw = readOptionalFiniteNumber(obj.timeoutMs, { min: 1 });
  const timeoutMs =
    timeoutMsRaw !== undefined ? Math.floor(timeoutMsRaw) : undefined;
  const apiKeyEnv =
    typeof obj.apiKeyEnv === "string" && obj.apiKeyEnv.length > 0
      ? obj.apiKeyEnv
      : undefined;
  const model =
    typeof obj.model === "string" && obj.model.length > 0
      ? obj.model
      : undefined;
  const safeAuto = parseDecisionSafeAuto(obj.safeAuto);
  const modelRouter = parseDecisionModelRouter(obj.modelRouter);
  const inputGuard = parseDecisionInputGuard(obj.inputGuard);
  if (
    mode === undefined &&
    backend === undefined &&
    endpoint === undefined &&
    timeoutMs === undefined &&
    apiKeyEnv === undefined &&
    model === undefined &&
    safeAuto === undefined &&
    modelRouter === undefined &&
    inputGuard === undefined
  ) {
    throw new JsonRpcError(
      "decision field required (mode, backend, endpoint, …)",
      JsonRpcErrorCode.INVALID_PARAMS,
    );
  }
  return {
    sessionId,
    ...(mode !== undefined ? { mode } : {}),
    ...(backend !== undefined ? { backend } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(safeAuto !== undefined ? { safeAuto } : {}),
    ...(modelRouter !== undefined ? { modelRouter } : {}),
    ...(inputGuard !== undefined ? { inputGuard } : {}),
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

/** `session/agent_message` — steer a continuable child. */
export function parseSessionAgentMessageParams(params: unknown): {
  sessionId: string;
  agentId: string;
  message: string;
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const obj = params as { agentId?: unknown; message?: unknown };
  const sessionId = readSessionId(params);
  if (typeof obj.agentId !== "string" || obj.agentId.length === 0) {
    throw new JsonRpcError("agentId required", JsonRpcErrorCode.INVALID_PARAMS);
  }
  if (typeof obj.message !== "string" || obj.message.length === 0) {
    throw new JsonRpcError("message required", JsonRpcErrorCode.INVALID_PARAMS);
  }
  return { sessionId, agentId: obj.agentId, message: obj.message };
}

/** `session/agent_interrupt` — stop a child's current turn. */
export function parseSessionAgentInterruptParams(params: unknown): {
  sessionId: string;
  agentId: string;
  reason?: string;
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const obj = params as { agentId?: unknown; reason?: unknown };
  const sessionId = readSessionId(params);
  if (typeof obj.agentId !== "string" || obj.agentId.length === 0) {
    throw new JsonRpcError("agentId required", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const reason =
    typeof obj.reason === "string" && obj.reason.length > 0
      ? obj.reason
      : undefined;
  return {
    sessionId,
    agentId: obj.agentId,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** `workspace/add` — remember a project directory. */
export function parseWorkspaceAddParams(params: unknown): {
  path: string;
  name?: string;
} {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const obj = params as { path?: unknown; name?: unknown };
  if (typeof obj.path !== "string" || obj.path.length === 0) {
    throw new JsonRpcError("path required", JsonRpcErrorCode.INVALID_PARAMS);
  }
  // A relative path would resolve against the *server's* cwd, which is not
  // what a remote client means by it. Requiring an absolute path turns a
  // silent surprise into a clear error.
  if (!isAbsolute(obj.path)) {
    throw new JsonRpcError(
      "path must be absolute",
      JsonRpcErrorCode.INVALID_PARAMS,
    );
  }
  const name =
    typeof obj.name === "string" && obj.name.trim().length > 0
      ? obj.name
      : undefined;
  return { path: obj.path, ...(name !== undefined ? { name } : {}) };
}

/** `workspace/remove` — forget a project directory. */
export function parseWorkspaceRemoveParams(params: unknown): { path: string } {
  if (params === null || typeof params !== "object") {
    throw new JsonRpcError("invalid params", JsonRpcErrorCode.INVALID_PARAMS);
  }
  const obj = params as { path?: unknown };
  if (typeof obj.path !== "string" || obj.path.length === 0) {
    throw new JsonRpcError("path required", JsonRpcErrorCode.INVALID_PARAMS);
  }
  return { path: obj.path };
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
