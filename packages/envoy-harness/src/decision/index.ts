export type {
  DecisionAnswer,
  DecisionBackendKind,
  DecisionClient,
  DecisionConfig,
  DecisionInputGuardConfig,
  DecisionMode,
  DecisionModelProfile,
  DecisionModelRouterConfig,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
  DecisionSafeAutoConfig,
  SafeAutoMapped,
  SafeAutoRecord,
} from "./types.js";

export {
  DecisionConfigSchema,
  DecisionInputGuardConfigSchema,
  DecisionModelProfileSchema,
  DecisionModelRouterConfigSchema,
  DecisionSafeAutoConfigSchema,
  createDecisionClient,
  decisionConfigPublic,
  defaultDecisionConfig,
  mergeDecisionConfig,
  patchDecisionConfig,
  type DecisionConfigLayer,
} from "./config.js";

export { NullDecisionClient } from "./null-client.js";
export { FakeDecisionClient } from "./fake-client.js";
export { HttpDecisionClient, type HttpDecisionClientOptions } from "./http-client.js";

export { predictWithTimeout } from "./predict.js";

export {
  SAFE_AUTO_QUESTIONS,
  applySafeAutoMode,
  buildSafeAutoState,
  makeSafeAutoRecord,
  mapSafeAutoAnswers,
  redactArgsPreview,
  type SafeAutoStateInput,
} from "./safe-auto.js";

export {
  resolveSafeAutoAsk,
  type ResolveSafeAutoAskInput,
  type ResolveSafeAutoAskResult,
} from "./resolve-ask.js";

export {
  INPUT_GUARD_QUESTIONS,
  buildInputGuardState,
  mapInputGuardBlock,
  resolveInputGuard,
  type InputGuardRecord,
  type ResolveInputGuardInput,
  type ResolveInputGuardResult,
} from "./input-guard.js";

export {
  MODEL_ROUTER_QUESTIONS_BASE,
  UNMATCHED_MODEL_PROFILE_ID,
  buildModelRouterQuestions,
  buildModelRouterState,
  mapModelRouterChoice,
  matchModelRouterProfile,
  resolveIncumbentProfileId,
  resolveModelRouter,
  type ModelRouterRecord,
  type ResolveModelRouterInput,
  type ResolveModelRouterResult,
} from "./model-router.js";
