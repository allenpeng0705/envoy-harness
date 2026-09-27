/**
 * System One decision-client contract (Laya / TypeSafe Jev compatible).
 *
 * Design: `docs/laya-decision-addons.md`. Off by default; consumers own
 * thresholds. Package 1 never hard-depends on Python/Torch.
 */

/** Three System One question shapes. */
export type DecisionQuestion =
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string | null>;
    }
  | {
      type: "score";
      instructions: string;
      /** Ordered levels, low → high. Length 2–10. */
      criteria: string[];
    }
  | {
      type: "noul";
      instructions: string;
      criteria?: { true?: string; false?: string };
    };

export type DecisionAnswer =
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence?: number;
    }
  | {
      type: "score";
      score: number;
      distribution: Record<string, number>;
      confidence?: number;
    }
  | {
      type: "noul";
      noul: number;
    };

export interface DecisionRequest {
  state: string;
  questions: Record<string, DecisionQuestion>;
  signal?: AbortSignal;
  /** Optional model / checkpoint hint (Jev alias or Laya checkpoint). */
  modelHint?: string;
}

export interface DecisionResponse {
  answers: Record<string, DecisionAnswer>;
  backend: string;
  model?: string;
  usage?: { inputTokens?: number; latencyMs?: number };
}

export interface DecisionClient {
  readonly id: string;
  predict(req: DecisionRequest): Promise<DecisionResponse>;
}

/** Gate mode. Default off — no network, no behavior change. */
export type DecisionMode = "off" | "shadow" | "enforce";

/** Pluggable backends. `onnx` reserved; v1 uses null / http. */
export type DecisionBackendKind = "null" | "laya-http" | "jev" | "onnx";

export interface DecisionSafeAutoConfig {
  enabled: boolean;
  tools: ReadonlyArray<string>;
  destructiveThreshold: number;
  minConfidence: number;
  /** Phase 3b — v1 always false. */
  honorDeny: boolean;
}

/** Named coding-model profile for Add-on B. */
export interface DecisionModelProfile {
  id: string;
  provider: string;
  model: string;
  baseUrl?: string;
  description?: string;
  /** When false, high needs_tools upgrades away from this profile. Default true. */
  toolsOk?: boolean;
}

export interface DecisionModelRouterConfig {
  enabled: boolean;
  timeoutMs: number;
  minConfidence: number;
  defaultProfile: string;
  /** Cost ladder: index 0 = cheapest. */
  profiles: ReadonlyArray<DecisionModelProfile>;
}

export interface DecisionInputGuardConfig {
  enabled: boolean;
  timeoutMs: number;
  /** Block when any injection/jailbreak/exfil noul ≥ this. */
  injectionThreshold: number;
  /** And harm_severity score ≥ this (0-based rubric). */
  harmScoreBlock: number;
  /** Enforce-only: when false, log only (shadow side effects). */
  honorBlock: boolean;
}

export interface DecisionConfig {
  mode: DecisionMode;
  backend: DecisionBackendKind;
  endpoint?: string;
  timeoutMs: number;
  /** Env var name holding the bearer token (never the secret itself). */
  apiKeyEnv?: string;
  /** Optional default model field for HTTP backends. */
  model?: string;
  safeAuto: DecisionSafeAutoConfig;
  modelRouter: DecisionModelRouterConfig;
  inputGuard: DecisionInputGuardConfig;
}

export type SafeAutoMapped = "allow" | "ask" | "deny";

export interface SafeAutoRecord {
  ts: string;
  tool: string;
  incumbentAsk: boolean;
  decisionBackend: string;
  model?: string;
  mapped: SafeAutoMapped;
  mode: DecisionMode;
  latencyMs: number;
  error?: string;
}
