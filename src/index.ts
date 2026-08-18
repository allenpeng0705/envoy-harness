/**
 * @envoymesh/envoy-harness — public API entry point.
 *
 * Phase 1: types only. The runtime lands in subsequent phases per
 * the design doc §22 (Migration and timeline).
 *
 * See `docs/design.md` for the full design.
 */

export const VERSION = "0.0.0" as const;

// Re-export the type system (§5 of the design doc)
export {
  AGENTS_MD_FILENAME,
  AGENTS_OVERRIDE_FILENAME,
  AgentRuntimeSchema,
  AskForApprovalSchema,
  DEFAULT_PROJECT_DOC_MAX_BYTES,
  DEFAULT_PROJECT_ROOT_MARKERS,
  ENVOY_HARNESS_LOCAL_VERSION,
  HookEventNameSchema,
  PermissionModeSchema,
  PermissionProfileNameSchema,
  SandboxBackendSchema,
  SkillIdSchema,
  VerdictEntrySchema,
  VerdictSchema,
  VerifierSourceSchema,
} from "./types.js";

export type {
  AgentRuntime,
  AskForApproval,
  BashValidationInput,
  BashValidator,
  BashVerdict,
  DiscoveredAgentsDoc,
  HookDecision,
  HookEvent,
  HookEventName,
  HookFn,
  HookHandler,
  LoadedAgentsMd,
  PermissionMode,
  PermissionProfileName,
  ProfileRef,
  SandboxBackend,
  SandboxPolicy,
  SkillId,
  Verdict,
  VerdictEntry,
  VerifierSource,
} from "./types.js";

// Re-export the bash safety composition (§6.2 of the design doc)
export {
  ALL_VALIDATORS,
  commandSemanticsValidation,
  destructiveCommandWarning,
  modeValidation,
  pathValidation,
  readOnlyValidation,
  sedValidation,
  validateBash,
} from "./permissions/bash/index.js";

export { hasUnbalancedQuotes, containsBackticks } from "./permissions/bash/semantics.js";

// Re-export AGENTS.md discovery (§9 of the design doc)
export { discoverAgentsMd, type DiscoveryOptions } from "./agents-md/index.js";

// Re-export the hook system (§8.2 of the design doc)
export {
  HookRegistry,
  defaultRegistry,
  runModuleHandler,
  runShellHandler,
  type HookMiddleware,
} from "./hooks/index.js";
