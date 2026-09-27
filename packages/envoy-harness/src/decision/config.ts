/**
 * Decision-addon config: zod shape, defaults, env merge, client factory.
 */

import { z } from "zod";

import { HttpDecisionClient } from "./http-client.js";
import { NullDecisionClient } from "./null-client.js";
import type {
  DecisionBackendKind,
  DecisionClient,
  DecisionConfig,
  DecisionInputGuardConfig,
  DecisionMode,
  DecisionModelRouterConfig,
  DecisionSafeAutoConfig,
} from "./types.js";

export const DecisionSafeAutoConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    tools: z.array(z.string().min(1)).optional(),
    destructiveThreshold: z.number().min(0).max(1).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    honorDeny: z.boolean().optional(),
  })
  .strict();

export const DecisionModelProfileSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    baseUrl: z.string().min(1).optional(),
    description: z.string().optional(),
    toolsOk: z.boolean().optional(),
  })
  .strict();

export const DecisionModelRouterConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    defaultProfile: z.string().min(1).optional(),
    profiles: z.array(DecisionModelProfileSchema).optional(),
  })
  .strict();

export const DecisionInputGuardConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
    injectionThreshold: z.number().min(0).max(1).optional(),
    harmScoreBlock: z.number().min(0).max(10).optional(),
    honorBlock: z.boolean().optional(),
  })
  .strict();

export const DecisionConfigSchema = z
  .object({
    mode: z.enum(["off", "shadow", "enforce"]).optional(),
    backend: z.enum(["null", "laya-http", "jev", "onnx"]).optional(),
    endpoint: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    safeAuto: DecisionSafeAutoConfigSchema.optional(),
    modelRouter: DecisionModelRouterConfigSchema.optional(),
    inputGuard: DecisionInputGuardConfigSchema.optional(),
  })
  .strict();

export type DecisionConfigLayer = z.infer<typeof DecisionConfigSchema>;

const DEFAULT_SAFE_AUTO_TOOLS = [
  "bash",
  "write_file",
  "apply_patch",
  "edit",
] as const;

function defaultModelRouter(): DecisionModelRouterConfig {
  return {
    enabled: false,
    timeoutMs: 80,
    minConfidence: 0.7,
    defaultProfile: "strong",
    profiles: [],
  };
}

function defaultInputGuard(): DecisionInputGuardConfig {
  return {
    enabled: false,
    timeoutMs: 100,
    injectionThreshold: 0.85,
    harmScoreBlock: 2.0,
    honorBlock: true,
  };
}

export function defaultDecisionConfig(): DecisionConfig {
  return {
    mode: "off",
    backend: "null",
    timeoutMs: 80,
    safeAuto: {
      enabled: true,
      tools: [...DEFAULT_SAFE_AUTO_TOOLS],
      destructiveThreshold: 0.55,
      minConfidence: 0.7,
      honorDeny: false,
    },
    modelRouter: defaultModelRouter(),
    inputGuard: defaultInputGuard(),
  };
}

function mergeModelRouter(
  partial: DecisionConfigLayer["modelRouter"],
  base: DecisionModelRouterConfig,
): DecisionModelRouterConfig {
  const p = partial ?? {};
  const profiles = p.profiles ?? base.profiles;
  const defaultProfile = p.defaultProfile ?? base.defaultProfile;
  return {
    enabled: p.enabled ?? base.enabled,
    timeoutMs: p.timeoutMs ?? base.timeoutMs,
    minConfidence: p.minConfidence ?? base.minConfidence,
    defaultProfile:
      profiles.some((x) => x.id === defaultProfile) || profiles.length === 0
        ? defaultProfile
        : (profiles[0]?.id ?? defaultProfile),
    profiles: profiles.map((prof) => ({
      id: prof.id,
      provider: prof.provider,
      model: prof.model,
      ...(prof.baseUrl !== undefined ? { baseUrl: prof.baseUrl } : {}),
      ...(prof.description !== undefined
        ? { description: prof.description }
        : {}),
      ...(prof.toolsOk !== undefined ? { toolsOk: prof.toolsOk } : {}),
    })),
  };
}

function mergeInputGuard(
  partial: DecisionConfigLayer["inputGuard"],
  base: DecisionInputGuardConfig,
): DecisionInputGuardConfig {
  const p = partial ?? {};
  return {
    enabled: p.enabled ?? base.enabled,
    timeoutMs: p.timeoutMs ?? base.timeoutMs,
    injectionThreshold: p.injectionThreshold ?? base.injectionThreshold,
    harmScoreBlock: p.harmScoreBlock ?? base.harmScoreBlock,
    honorBlock: p.honorBlock ?? base.honorBlock,
  };
}

/** Merge a partial layer onto defaults (undefined fields keep defaults). */
export function mergeDecisionConfig(
  partial: DecisionConfigLayer | undefined,
  env: NodeJS.ProcessEnv = process.env,
): DecisionConfig {
  const base = defaultDecisionConfig();
  const fromFile = partial ?? {};
  const mode = (env["ENVOY_DECISION_MODE"] as DecisionMode | undefined) ??
    fromFile.mode ??
    base.mode;
  const backend =
    (env["ENVOY_DECISION_BACKEND"] as DecisionBackendKind | undefined) ??
    fromFile.backend ??
    base.backend;
  const endpoint =
    env["ENVOY_DECISION_ENDPOINT"] ?? fromFile.endpoint ?? base.endpoint;
  const timeoutRaw = env["ENVOY_DECISION_TIMEOUT_MS"];
  const timeoutMs =
    timeoutRaw !== undefined && timeoutRaw.length > 0
      ? Number(timeoutRaw)
      : (fromFile.timeoutMs ?? base.timeoutMs);
  const apiKeyEnv =
    env["ENVOY_DECISION_API_KEY_ENV"] ??
    fromFile.apiKeyEnv ??
    (backend === "jev" ? "TYPESAFE_API_KEY" : undefined) ??
    base.apiKeyEnv;
  const model = env["ENVOY_DECISION_MODEL"] ?? fromFile.model ?? base.model;
  const sa = fromFile.safeAuto ?? {};
  const safeAuto: DecisionSafeAutoConfig = {
    enabled: sa.enabled ?? base.safeAuto.enabled,
    tools: sa.tools ?? base.safeAuto.tools,
    destructiveThreshold:
      sa.destructiveThreshold ?? base.safeAuto.destructiveThreshold,
    minConfidence: sa.minConfidence ?? base.safeAuto.minConfidence,
    honorDeny: sa.honorDeny ?? base.safeAuto.honorDeny,
  };
  return {
    mode: mode === "off" || mode === "shadow" || mode === "enforce" ? mode : "off",
    backend:
      backend === "null" ||
      backend === "laya-http" ||
      backend === "jev" ||
      backend === "onnx"
        ? backend
        : "null",
    ...(endpoint !== undefined ? { endpoint } : {}),
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : base.timeoutMs,
    ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
    ...(model !== undefined ? { model } : {}),
    safeAuto,
    modelRouter: mergeModelRouter(fromFile.modelRouter, base.modelRouter),
    inputGuard: mergeInputGuard(fromFile.inputGuard, base.inputGuard),
  };
}

/** Build a client from resolved config. Mode `off` → null client. */
export function createDecisionClient(
  config: DecisionConfig,
  env: NodeJS.ProcessEnv = process.env,
): DecisionClient {
  if (config.mode === "off" || config.backend === "null") {
    return new NullDecisionClient();
  }
  if (config.backend === "onnx") {
    return new NullDecisionClient();
  }
  if (config.backend === "laya-http" || config.backend === "jev") {
    const endpoint =
      config.endpoint ??
      (config.backend === "jev"
        ? "https://api.typesafe.ai/v1/systemone"
        : "http://127.0.0.1:8000/v1/systemone");
    const apiKey =
      config.apiKeyEnv !== undefined ? env[config.apiKeyEnv] : undefined;
    return new HttpDecisionClient({
      kind: config.backend,
      endpoint,
      ...(typeof apiKey === "string" && apiKey.length > 0
        ? { apiKey }
        : {}),
      ...(config.model !== undefined ? { defaultModel: config.model } : {}),
    });
  }
  return new NullDecisionClient();
}

/** Public snapshot for config/get and host UIs (no secrets). */
export function decisionConfigPublic(
  config: DecisionConfig,
): Record<string, unknown> {
  return {
    mode: config.mode,
    backend: config.backend,
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    timeoutMs: config.timeoutMs,
    ...(config.apiKeyEnv !== undefined ? { apiKeyEnv: config.apiKeyEnv } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
    safeAuto: {
      enabled: config.safeAuto.enabled,
      tools: [...config.safeAuto.tools],
      destructiveThreshold: config.safeAuto.destructiveThreshold,
      minConfidence: config.safeAuto.minConfidence,
      honorDeny: config.safeAuto.honorDeny,
    },
    modelRouter: {
      enabled: config.modelRouter.enabled,
      timeoutMs: config.modelRouter.timeoutMs,
      minConfidence: config.modelRouter.minConfidence,
      defaultProfile: config.modelRouter.defaultProfile,
      profiles: config.modelRouter.profiles.map((p) => ({
        id: p.id,
        provider: p.provider,
        model: p.model,
        ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.toolsOk !== undefined ? { toolsOk: p.toolsOk } : {}),
      })),
    },
    inputGuard: {
      enabled: config.inputGuard.enabled,
      timeoutMs: config.inputGuard.timeoutMs,
      injectionThreshold: config.inputGuard.injectionThreshold,
      harmScoreBlock: config.inputGuard.harmScoreBlock,
      honorBlock: config.inputGuard.honorBlock,
    },
  };
}

/**
 * Apply a runtime patch (`session/set_decision`) onto the current config.
 * Does not re-read process env — the patch is authoritative for this session.
 * Nested `modelRouter` / `inputGuard` / `safeAuto` merge onto `current`, not
 * package defaults (so a partial patch cannot wipe profiles).
 */
export function patchDecisionConfig(
  current: DecisionConfig,
  patch: DecisionConfigLayer,
): DecisionConfig {
  const safeAuto: DecisionSafeAutoConfig = {
    enabled: patch.safeAuto?.enabled ?? current.safeAuto.enabled,
    tools: [...(patch.safeAuto?.tools ?? current.safeAuto.tools)],
    destructiveThreshold:
      patch.safeAuto?.destructiveThreshold ??
      current.safeAuto.destructiveThreshold,
    minConfidence:
      patch.safeAuto?.minConfidence ?? current.safeAuto.minConfidence,
    honorDeny: patch.safeAuto?.honorDeny ?? current.safeAuto.honorDeny,
  };
  const modelRouter = mergeModelRouter(patch.modelRouter, current.modelRouter);
  const inputGuard = mergeInputGuard(patch.inputGuard, current.inputGuard);
  return {
    mode: patch.mode ?? current.mode,
    backend: patch.backend ?? current.backend,
    ...(patch.endpoint !== undefined
      ? { endpoint: patch.endpoint }
      : current.endpoint !== undefined
        ? { endpoint: current.endpoint }
        : {}),
    timeoutMs: patch.timeoutMs ?? current.timeoutMs,
    ...(patch.apiKeyEnv !== undefined
      ? { apiKeyEnv: patch.apiKeyEnv }
      : current.apiKeyEnv !== undefined
        ? { apiKeyEnv: current.apiKeyEnv }
        : {}),
    ...(patch.model !== undefined
      ? { model: patch.model }
      : current.model !== undefined
        ? { model: current.model }
        : {}),
    safeAuto,
    modelRouter,
    inputGuard,
  };
}
