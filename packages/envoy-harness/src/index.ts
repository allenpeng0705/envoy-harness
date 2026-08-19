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
  AskDecision,
  AskForApproval,
  AskHandler,
  AskRequest,
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

// F14.1: re-export the persistence layer (PersistedSession
// + SessionStore). Hosts wire these via `Agent(session: ...)`
// or via the CLI's --resume / --fork / --persist flags.
export {
  PersistedSession,
  type PersistedSessionCreateOptions,
  SessionStore,
  type SessionStoreOptions,
} from "./session/index.js";

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

// Re-export cost tracking (§14 of the design doc, F7.1)
export {
  CostTracker,
  DEFAULT_PRICING,
  computeCost,
  type RunCost,
  type TokenPrice,
  type Usage,
} from "./cost.js";

// Re-export the LLM adapters + provider dispatch (§14 of the design doc, F7)
export {
  AnthropicAdapter,
  DeepSeekAdapter,
  FakeHttpClient,
  FetchHttpClient,
  OpenAIAdapter,
  createProviderAdapter,
  DEFAULT_PROVIDER_MODELS,
  isAnthropic2xx,
  isOpenAI2xx,
  messagesToAnthropic,
  messagesToOpenAI,
  parseAnthropicError,
  parseChatResponse,
  parseMessagesResponse,
  parseOpenAIError,
  splitSystemAndMessages,
  toolsToAnthropic,
  toolsToOpenAI,
  zodToJsonSchema,
  SUPPORTED_PROVIDERS,
  type AnthropicAdapterOptions,
  type AnthropicToolDefinition,
  type DeepSeekAdapterOptions,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type OpenAIAdapterOptions,
  type OpenAIMessage,
  type OpenAIToolCall,
  type OpenAIToolDefinition,
  type ProviderConfig,
  type SupportedProvider,
} from "./llm/index.js";

// Re-export the CLI (§19 of the design doc)
export {
  ArgvError,
  CliError,
  EXIT_DATAERR,
  EXIT_ERROR,
  EXIT_NOINPUT,
  EXIT_OK,
  EXIT_USAGE,
  BUILTIN_COMMANDS,
  BUILTIN_INFO_COMMANDS,
  BUILTIN_TIER2_BATCH2_COMMANDS,
  BUILTIN_TIER2_BATCH3_COMMANDS,
  BUILTIN_TIER2_BATCH4_COMMANDS,
  BUILTIN_TIER2_COMMANDS,
  ReplCommandRegistry,
  defaultAskHandler,
  dispatchCommand,
  formatHelp,
  parseArgs,
  parseCommandLine,
  run,
  runRepl,
  type DispatchResult,
  type ExitCode,
  type LineReader,
  type ParsedArgs,
  type ReplCommand,
  type ReplContext,
  type ReplOptions,
  type ReplProfile,
  type ReplProfileLoader,
  type ReplResult,
  type SubagentRegistry,
  type RunOptions,
  type RunResult,
  type RunParsedArgs,
  type SelfEvolveParsedArgs,
  type CliRunResult,
  type SelfEvolveRunResult,
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
  type Verdict,
  type VerifierRule,
} from "./verifier/index.js";

// Re-export the LSP integration (F9.2, §22 Phase 4)
export {
  FakeStdio,
  MockLspClient,
  NoopLspClient,
  StaticLspManager,
  StdioLspClient,
  frameLspMessage,
  makeLspTools,
  type LspClient,
  type LspClientMap,
  type LspDiagnostic,
  type LspHover,
  type LspLocation,
  type LspManager,
  type LspProcess,
  type MockLspCall,
  type MockLspResponseTable,
  type StdioLspClientOptions,
} from "./lsp/index.js";

// Re-export the trace layer (F9.4, §19 of the design doc)
export {
  JsonLinesTracer,
  NullTracer,
  VerboseTracer,
  formatVerbose,
  type AgentEndEvent,
  type AgentStartEvent,
  type ErrorEvent,
  type ModelResponseEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type TraceEvent,
  type Tracer,
  type WritableStream,
} from "./trace/index.js";

// Re-export the team layer (F9.3, §22 of the design doc)
export {
  TomlParseError,
  parseTeamToml,
  Team,
  type AgentRunResult,
  type AgentSpec,
  type ScheduleSpec,
  type TeamConfig,
  type TeamOptions,
  type TeamResult,
} from "./team/index.js";

// Re-export the sub-agent types + default implementations (F10.1, §10.3)
export {
  LocalMeshSubmitter,
  NOOP_MESH_SUBMITTER_ERROR,
  NoopMeshSubmitter,
  TaskInputSchema,
  defaultBuildSubagentFactory,
  makeTaskTool,
  FanOutRegistry,
  aggregateFanOutResults,
  type DefaultBuildSubagentFactoryOptions,
  type FanOutSpec,
  type LocalMeshSubmitterOptions,
  type MakeTaskToolOptions,
  type MeshSubmitter,
  type RoutingHint,
  type SubagentInput,
  type SubagentRecord,
  type SubagentResult,
  type SubagentResultSigner,
  type TaskInput,
  type TaskResult,
} from "./subagent/index.js";

// Re-export the scoreboard (§13 of the design doc)
export {
  BenchmarkSchema,
  DefaultBenchmarkRunner,
  FederatedAdoptionRecordSchema,
  FederatedAdoptionsSchema,
  FederatedScoreboard,
  LocalPeerSource,
  ModelHypothesisProvider,
  ScoreboardEntrySchema,
  ScoreboardSchema,
  SelfEvolve,
  appendAdoption,
  appendEntry,
  buildHypothesisPrompt,
  hashRuleset,
  loadRulesetFromFile,
  parseHypothesisFromLlm,
  readAdoptions,
  readBenchmark,
  readScoreboard,
  signEntry,
  verifyEntrySignature,
  writeBenchmark,
  writeScoreboard,
  type AdoptedCandidate,
  type AdoptResult,
  type Benchmark,
  type BenchmarkResult,
  type BenchmarkRunner,
  type BenchmarkTask,
  type FederatedAdoptionRecord,
  type FederatedAdoptions,
  type Hypothesis,
  type HypothesisProvider,
  type PeerScoreboard,
  type PeerSource,
  type PullOptions,
  type PullResult,
  type RunOneCycleResult,
  type Scoreboard,
  type ScoreboardEntry,
  type SelfEvolveOptions,
  type SelfEvolvePaths,
  type VerifierRuleset,
} from "./scoreboard/index.js";

// T2.2: re-export the config loader (TOML). Closes
// §2.5 row #1 in the implementation plan.
export {
  ConfigLayerSchema,
  ConfigLoadError,
  DEFAULT_CONFIG_PATH,
  loadConfig,
  loadConfigFile,
  resolveConfigPath,
  type ConfigLayer,
} from "./config/index.js";

// T3.3: re-export the MCP (Model Context Protocol)
// type seam. Closes §2.5 row #2 (the type side;
// the stdio transport is a follow-up sub-chunk).
export {
  MCP_TOOL_PREFIX,
  DefaultMcpClientRegistry,
  mcpToolName,
  parseMcpToolName,
  type McpClient,
  type McpClientRegistry,
  type McpCallToolResult,
  type McpTool,
} from "./mcp/index.js";
