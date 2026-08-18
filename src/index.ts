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

// Re-export the tool system (§10 of the design doc)
export {
  DuplicateToolError,
  ToolRegistry,
  type ContentBlock,
  type Message,
  type Role,
  type Tool,
  type ToolCall,
  type ToolContext,
  type ToolResult,
} from "./tools/index.js";

// Re-export the model adapter (§3.4 of the design doc)
export type {
  CompleteInput,
  ModelAdapter,
  ModelResponse,
} from "./model.js";

// Re-export the session (§3.2 of the design doc)
export {
  InMemorySession,
  newSessionId,
  type Session,
  type SessionMetadata,
} from "./session.js";

// Re-export the agent loop (§3.4 of the design doc)
export {
  Agent,
  DEFAULT_MAX_ITERATIONS,
  type AgentOptions,
  type AgentResult,
} from "./agent.js";

// Re-export built-in tools (§10 of the design doc)
export {
  BUILTIN_TOOLS,
  bashTool,
  readFileTool,
} from "./tools/builtin/index.js";

// Re-export the CLI (§19 of the design doc)
export {
  ArgvError,
  CliError,
  EXIT_DATAERR,
  EXIT_ERROR,
  EXIT_NOINPUT,
  EXIT_OK,
  EXIT_USAGE,
  formatHelp,
  parseArgs,
  run,
  type ExitCode,
  type ParsedArgs,
  type RunOptions,
  type RunResult,
} from "./cli/index.js";

// Re-export the verifier (§12 of the design doc)
export {
  DEFAULT_RULES,
  approvalRespectedRule,
  combineVerdicts,
  concatText,
  costReasonableForWorkRule,
  extractKeywords,
  meshTaskShapeRule,
  nonEmptyContentRule,
  outputMatchesObjectiveRule,
  runVerifierRules,
  sandboxRespectedRule,
  type VerifierRule,
} from "./verifier/index.js";

// Re-export the scoreboard (§13 of the design doc)
export {
  BenchmarkSchema,
  ScoreboardEntrySchema,
  ScoreboardSchema,
  appendEntry,
  hashRuleset,
  readBenchmark,
  readScoreboard,
  signEntry,
  writeBenchmark,
  writeScoreboard,
  type Benchmark,
  type BenchmarkResult,
  type BenchmarkTask,
  type Scoreboard,
  type ScoreboardEntry,
  type VerifierRuleset,
} from "./scoreboard/index.js";
