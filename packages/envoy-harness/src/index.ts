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
  registerHooksFromConfig,
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
  type SessionProvenance,
} from "./session.js";

// F14.1: re-export the persistence layer (PersistedSession
// + SessionStore). Hosts wire these via `Agent(session: ...)`
// or via the CLI's --resume / --fork / --persist flags.
export {
  PersistedSession,
  type PersistedSessionCreateOptions,
  SessionStore,
  type SessionStoreOptions,
  createSessionQueryService,
  makeSessionQueryTool,
  registerSessionQueryTool,
  indexSessionDirectory,
  indexSessionFile,
  isPathInside,
  type SessionIndexEntry,
  type SessionIndexerOptions,
  type SessionQueryHit,
  type SessionQueryRequest,
  type SessionQueryService,
  type SessionQueryServiceOptions,
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
  makeBashTool,
  readFileTool,
  type MakeBashToolOptions,
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
  createJsonlTelemetrySink,
  createNullTelemetrySink,
  wrapTracerAsTelemetrySink,
  assertRedactionInvariant,
  assertTraceEventShape,
  InvariantError,
  type AgentEndEvent,
  type AgentStartEvent,
  type ErrorEvent,
  type ModelResponseEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type TraceEvent,
  type Tracer,
  type WritableStream,
  type TelemetryCounters,
  type TelemetrySink,
  type JsonlTelemetrySinkOptions,
  type InvariantKind,
  type RedactionInvariantOptions,
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

// Re-export the bounded context fragments (Phase 8 / v2.1,
// the Codex ContextualUserFragment rule, ported)
export {
  assembleFragments,
  createBoundedFragment,
  DEFAULT_ASSEMBLY_TOKEN_BUDGET,
  DEFAULT_FRAGMENT_TOKEN_CAP,
  type AssembledContext,
  type BoundedFragmentOptions,
  type ContextualUserFragment,
} from "./context/fragment.js";

// T2.2: re-export the config loader (TOML). Closes
// §2.5 row #1 in the implementation plan.
//
// Phase B / Item 15: also re-export the codex + deepseek
// config importers + the import-format helpers +
// `HookHandlerSpec` (the config-layer hook shape).
// Chunk 15.1 ships the codex importer; chunk 15.2 adds
// the deepseek `cordis.yml` importer + the CC hooks.json
// bridge. The hook-protocol JSON-RPC bridge is folded
// into `runShellHandler` (deepseek codec extensions).
export {
  ConfigLayerSchema,
  ConfigLoadError,
  DEFAULT_CONFIG_PATH,
  HookHandlerSpecSchema,
  importCodexConfig,
  importDeepseekConfig,
  isImportFormat,
  loadConfig,
  loadConfigFile,
  loadConfigWithImport,
  parseClaudeCodeHooks,
  resolveConfigPath,
  SUPPORTED_IMPORT_FORMATS,
  type ConfigLayer,
  type CodexImportResult,
  type CodexImportWarning,
  type DeepseekImportResult,
  type DeepseekImportWarning,
  type HookHandlerSpec,
  type ImportCodexOptions,
  type ImportDeepseekOptions,
  type ImportFormat,
  type ParseClaudeCodeHooksOptions,
  type ParseClaudeCodeHooksResult,
  type SkippedCcHook,
} from "./config/index.js";

// Phase B / Item 3.1: the plugin system. The
// capability-module seam + the built-in `audit-log`
// sample + the curated whitelist.
export {
  auditLogPlugin,
  AuditLogConfigSchema,
  CalculatorError,
  calculatorPlugin,
  CalculatorConfigSchema,
  confirmToolPlugin,
  ConfirmToolConfigSchema,
  evaluateExpression,
  getBuiltinPlugin,
  isBuiltinPlugin,
  isWhitelistedPlugin,
  loadPlugin,
  mergePluginConfigs,
  parsePluginConfigEntry,
  PLUGIN_WHITELIST,
  PluginConfigError,
  PluginConfigParseError,
  PluginLoadError,
  PluginRegistry,
  validatePluginConfig,
  type AuditLogConfig,
  type CalculatorConfig,
  type CapabilityContext,
  type CapabilityModule,
  type ConfirmToolConfig,
  type Disposable,
  type LoadPluginOptions,
  type PluginConfigEntry,
  type PluginLogger,
  type ZodIssueLike,
} from "./plugins/index.js";

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

// T3.4: re-export the OS sandbox executor interface
// + the no-op default. Closes §2.5 row #3 (the
// seam side; landlock / process-fs-namespace
// backends land in T3.4.1 / T3.4.2 with a Linux
// test environment).
export {
  NoopSandboxExecutor,
  type SandboxContext,
  type SandboxExecutor,
  type SandboxResult,
} from "./sandbox/index.js";

// Phase A / Item 5 — the user-question service
// (open-ended user questions + approval delegation).
// The REPL provider is the package-1 default; the
// Tauri / mesh providers land in the adapter.
//
// Chunk 5.1: service + REPL provider.
// Chunk 5.2: ask_user tool + AskForApproval shim.
export {
  createAskForApprovalShim,
  createReplStdinProvider,
  createUserQuestionService,
  DEFAULT_MULTILINE_SENTINEL,
  makeAskUserTool,
  type AskUserInput,
  type CreateAskForApprovalShimOptions,
  type MakeAskUserToolOptions,
  type ReplStdinProviderOptions,
  type UserQuestionAnswer,
  type UserQuestionProvider,
  type UserQuestionRequest,
  type UserQuestionService,
} from "./interaction/index.js";

// Phase A / Item 2 — the memory subsystem.
// Chunk 2.1: file-based store + citations + bounded
// injection. Chunk 2.2: session-end consolidation.
export {
  LocalMemoryStore,
  buildIndexFragment,
  buildMemoryFragment,
  buildMemoryIndex,
  consolidateMemories,
  estimateMemoryTokens,
  hashMemoryBody,
  parseCitation,
  parseMemoryFile,
  renderCitation,
  serializeMemoryFile,
  slugify,
  type ConsolidateOptions,
  type ConsolidateResult,
  type LocalMemoryStoreOptions,
  type Memory,
  type MemoryCitation,
  type MemoryMeta,
  type MemoryStore,
} from "./memories/index.js";

// Phase A / Item 6 — the plan subsystem.
// Chunk 6.1: state + injection. Chunk 6.2: /plan REPL
// command + `runReview` API (the deepseek-style
// plan-vs-result review). Note: the REPL keeps
// `/review` reserved for the F14.3 working-tree
// reviewer; the plan-mode review handoff is exposed
// via the `runReview` API only (hosts wire it).
export {
  PLAN_FRAGMENT_PRIORITY,
  PlanTransitionError,
  applyTransition,
  buildPlanFragment,
  createPlanState,
  renderPlanText,
  runReview,
  type PlanReviewStatus,
  type PlanState,
  type PlanTransition,
  type ReviewVerdict,
  type RunReviewOptions,
} from "./plan/index.js";

// Phase C — environment & long-running (items 7 / 8 / 9).
export {
  createLocalJobRegistry,
  createProcessJobHooks,
  JobError,
  makeJobTools,
  registerJobTools,
  type JobDoneListener,
  type JobHooks,
  type JobOutcome,
  type JobRead,
  type JobRegistry,
  type JobSnapshot,
  type JobStart,
  type JobStatus,
  type LocalJobRegistryOptions,
  type ProcessJobOptions,
} from "./jobs/index.js";

export {
  createFakeFetchProvider,
  createFakeSearchProvider,
  createHttpFetchProvider,
  createBraveSearchProvider,
  createWebRuntime,
  makeWebTools,
  registerWebTools,
  WebError,
  type BraveSearchProviderOptions,
  type HttpFetchProviderOptions,
  type WebErrorCode,
  type WebFetchBody,
  type WebFetchProvider,
  type WebFetchRequest,
  type WebFetchResult,
  type WebRuntime,
  type WebRuntimeConfig,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
  type WebSearchSource,
} from "./web/index.js";

export {
  createFakeTerminalBackend,
  createPtyTerminalBackend,
  isPtyAvailable,
  createTerminalSessionService,
  makeTerminalTools,
  registerTerminalTools,
  TerminalError,
  type FakeTerminalBackendOptions,
  type FakeTerminalSessionState,
  type TerminalBackend,
  type TerminalBackendSession,
  type TerminalBackendSpawnSpec,
  type TerminalErrorCode,
  type TerminalReadRequest,
  type TerminalReadResult,
  type TerminalSendOperation,
  type TerminalSendRequest,
  type TerminalSendResult,
  type TerminalSessionService,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSignal,
  type TerminalSpawnRequest,
  type TerminalWaitReason,
} from "./terminal/index.js";

export {
  createDefaultCredentials,
  wireEnvironmentTools,
  type EnvironmentCapabilities,
  type WireEnvironmentOptions,
} from "./environment/index.js";

// Phase C / Item 13 — credentials
export {
  createAskCredentialsProvider,
  createCredentialsProvider,
  createEnvCredentialsProvider,
  createFileCredentialsProvider,
  createRedactingTracer,
  CredentialError,
  type AskCredentialsOptions,
  type CredentialErrorCode,
  type CredentialReference,
  type CredentialSource,
  type CredentialsProvider,
  type EnvCredentialsOptions,
  type FileCredentialsOptions,
  type RedactingTracerOptions,
  type ResolveCredentialOptions,
} from "./credentials/index.js";

// Phase D / Item 16 — feedback
export {
  createFeedbackSidecar,
  createFeedbackStore,
  makeFeedbackTools,
  registerFeedbackTools,
  toSelfEvolveSignals,
  type FeedbackEvent,
  type FeedbackPolarity,
  type FeedbackSidecar,
  type FeedbackSidecarOptions,
  type FeedbackStore,
  type FeedbackStoreOptions,
  type MessageFeedback,
  type RecordFeedbackInput,
  type SelfEvolveFeedbackSignal,
} from "./feedback/index.js";
