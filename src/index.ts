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
