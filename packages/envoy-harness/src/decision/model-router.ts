/**
 * Add-on B — model router: pick a configured profile before the turn.
 * Design: docs/laya-decision-addons.md §5.
 */

import type {
  DecisionClient,
  DecisionConfig,
  DecisionMode,
  DecisionModelProfile,
  DecisionModelRouterConfig,
  DecisionQuestion,
  DecisionResponse,
} from "./types.js";
import { predictWithTimeout } from "./predict.js";

export const MODEL_ROUTER_QUESTIONS_BASE = {
  needs_tools: {
    type: "noul" as const,
    instructions: "Will this turn likely need tools (bash, edit, git)?",
  },
  difficulty: {
    type: "score" as const,
    instructions: "How hard is this for a coding model?",
    criteria: [
      "trivial — lookup or one-liner",
      "easy — short answer, little reasoning",
      "moderate — several steps",
      "hard — long multi-step or specialist knowledge",
    ],
  },
};

export function buildModelRouterQuestions(
  profiles: ReadonlyArray<DecisionModelProfile>,
): Record<string, DecisionQuestion> {
  const criteria: Record<string, string | null> = {};
  for (const p of profiles) {
    criteria[p.id] = p.description ?? `${p.provider}/${p.model}`;
  }
  return {
    tier: {
      type: "choice",
      instructions: "Which model profile should handle this turn?",
      criteria,
    },
    ...MODEL_ROUTER_QUESTIONS_BASE,
  };
}

export function buildModelRouterState(input: {
  prompt: string;
  autoRun?: string;
  sandbox?: string;
  profileIds: ReadonlyArray<string>;
}): string {
  const prompt = input.prompt.slice(0, 1200);
  return [
    `prompt: ${prompt}`,
    `sandbox: ${input.sandbox ?? ""} autoRun: ${input.autoRun ?? ""}`,
    `profiles: ${input.profileIds.join(", ")}`,
  ].join("\n");
}

/**
 * Sentinel incumbent when the live adapter does not match any configured
 * profile. Forces enforce apply when the router picks a real profile.
 */
export const UNMATCHED_MODEL_PROFILE_ID = "__unmatched__";

/**
 * Best-effort match of a live provider/model hint to a configured profile.
 * Prefer provider+model, then unique model, then unique provider.
 */
export function matchModelRouterProfile(
  cfg: DecisionModelRouterConfig,
  hint: { provider?: string; model?: string },
): string | undefined {
  const provider = hint.provider?.trim().toLowerCase();
  const model = hint.model?.trim();
  const hasProvider = provider !== undefined && provider.length > 0;
  const hasModel = model !== undefined && model.length > 0;
  if (!hasProvider && !hasModel) return undefined;

  if (hasProvider && hasModel) {
    const both = cfg.profiles.find(
      (p) => p.provider.toLowerCase() === provider && p.model === model,
    );
    if (both !== undefined) return both.id;
  }
  if (hasModel) {
    const byModel = cfg.profiles.filter((p) => p.model === model);
    if (byModel.length === 1) return byModel[0]!.id;
  }
  if (hasProvider) {
    const byProv = cfg.profiles.filter(
      (p) => p.provider.toLowerCase() === provider,
    );
    if (byProv.length === 1) return byProv[0]!.id;
  }
  return undefined;
}

/**
 * Resolve the incumbent profile id for turn-start routing.
 * Uses an explicit profile id when set; otherwise matches provider/model
 * hints; otherwise {@link UNMATCHED_MODEL_PROFILE_ID}.
 */
export function resolveIncumbentProfileId(
  cfg: DecisionModelRouterConfig,
  input: {
    profileId?: string;
    provider?: string;
    model?: string;
  },
): string {
  if (
    input.profileId !== undefined &&
    input.profileId.length > 0 &&
    input.profileId !== UNMATCHED_MODEL_PROFILE_ID
  ) {
    return input.profileId;
  }
  return (
    matchModelRouterProfile(cfg, {
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    }) ?? UNMATCHED_MODEL_PROFILE_ID
  );
}

/**
 * Map answers → profile id. Cost ladder = profiles array order (cheapest first).
 */
export function mapModelRouterChoice(
  response: DecisionResponse,
  cfg: DecisionModelRouterConfig,
): string {
  const ids = cfg.profiles.map((p) => p.id);
  if (ids.length === 0) return cfg.defaultProfile;

  const tier = response.answers["tier"];
  let pick =
    tier?.type === "choice" && ids.includes(tier.choice)
      ? tier.choice
      : cfg.defaultProfile;

  const confidence =
    tier?.type === "choice" ? tier.confidence : undefined;
  if (confidence !== undefined && confidence < cfg.minConfidence) {
    pick = cfg.defaultProfile;
  }

  const difficulty = response.answers["difficulty"];
  const difficultyScore =
    difficulty?.type === "score" ? difficulty.score : undefined;
  // Top band (hard): criteria length 4 → score near 3.
  if (
    difficultyScore !== undefined &&
    difficultyScore >= 2.5 &&
    pick === ids[0] &&
    ids[0] !== cfg.defaultProfile
  ) {
    pick = cfg.defaultProfile;
  }

  const needsTools = response.answers["needs_tools"];
  const needsToolsNoul =
    needsTools?.type === "noul" ? needsTools.noul : undefined;
  const profile = cfg.profiles.find((p) => p.id === pick);
  if (
    needsToolsNoul !== undefined &&
    needsToolsNoul >= 0.7 &&
    profile?.toolsOk === false
  ) {
    pick = cfg.defaultProfile;
  }

  return ids.includes(pick) ? pick : cfg.defaultProfile;
}

export interface ModelRouterRecord {
  ts: string;
  kind: "modelRouter";
  chosenProfileId: string;
  incumbentProfileId: string;
  applied: boolean;
  mode: DecisionMode;
  decisionBackend: string;
  latencyMs: number;
  error?: string;
}

export interface ResolveModelRouterInput {
  config: DecisionConfig;
  client: DecisionClient;
  prompt: string;
  /** Current profile id (or "incumbent" if unknown). */
  incumbentProfileId: string;
  autoRun?: string;
  sandbox?: string;
  onRecord?: (record: ModelRouterRecord) => void;
}

export interface ResolveModelRouterResult {
  /** Profile to use when mode=enforce and applied; else incumbent. */
  profileId: string;
  profile: DecisionModelProfile | undefined;
  /**
   * True when the caller should swap the adapter to `profileId`
   * (enforce + chosen ≠ incumbent). The caller owns the final audit
   * record after a successful/failed `createProviderAdapter`.
   */
  applied: boolean;
  record: ModelRouterRecord;
}

export async function resolveModelRouter(
  input: ResolveModelRouterInput,
): Promise<ResolveModelRouterResult> {
  const { config, client } = input;
  const mr = config.modelRouter;
  const incumbent = input.incumbentProfileId;
  const fallbackProfile =
    mr.profiles.find((p) => p.id === mr.defaultProfile) ?? mr.profiles[0];

  const makeRecord = (
    chosen: string,
    applied: boolean,
    latencyMs: number,
    backend: string,
    error?: string,
  ): ModelRouterRecord => ({
    ts: new Date().toISOString(),
    kind: "modelRouter",
    chosenProfileId: chosen,
    incumbentProfileId: incumbent,
    applied,
    mode: config.mode,
    decisionBackend: backend,
    latencyMs,
    ...(error !== undefined ? { error } : {}),
  });

  if (config.mode === "off" || !mr.enabled || mr.profiles.length === 0) {
    const record = makeRecord(incumbent, false, 0, client.id);
    return {
      profileId: incumbent,
      profile: mr.profiles.find((p) => p.id === incumbent) ?? fallbackProfile,
      applied: false,
      record,
    };
  }

  const started = Date.now();
  try {
    const response = await predictWithTimeout(
      client,
      {
        state: buildModelRouterState({
          prompt: input.prompt,
          ...(input.autoRun !== undefined ? { autoRun: input.autoRun } : {}),
          ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
          profileIds: mr.profiles.map((p) => p.id),
        }),
        questions: buildModelRouterQuestions(mr.profiles),
        ...(config.model !== undefined ? { modelHint: config.model } : {}),
      },
      mr.timeoutMs,
    );
    const chosen = mapModelRouterChoice(response, mr);
    const applied = config.mode === "enforce" && chosen !== incumbent;
    const record = makeRecord(
      chosen,
      applied,
      response.usage?.latencyMs ?? Date.now() - started,
      response.backend,
    );
    // Shadow / no-op: record here. Enforce apply: caller records after adapter swap.
    if (!applied) input.onRecord?.(record);
    return {
      profileId: applied ? chosen : incumbent,
      profile:
        mr.profiles.find((p) => p.id === (applied ? chosen : incumbent)) ??
        fallbackProfile,
      applied,
      record,
    };
  } catch (err) {
    // Design §5.5: error/timeout → defaultProfile (fail-open) in enforce.
    const failOpenId =
      config.mode === "enforce" ? mr.defaultProfile : incumbent;
    const applied =
      config.mode === "enforce" &&
      failOpenId !== incumbent &&
      mr.profiles.some((p) => p.id === failOpenId);
    const record = makeRecord(
      failOpenId,
      applied,
      Date.now() - started,
      client.id,
      err instanceof Error ? err.message : String(err),
    );
    if (!applied) input.onRecord?.(record);
    return {
      profileId: applied ? failOpenId : incumbent,
      profile:
        mr.profiles.find((p) => p.id === (applied ? failOpenId : incumbent)) ??
        fallbackProfile,
      applied,
      record,
    };
  }
}
