/**
 * Public API re-exports (interaction, env, protocol, skills).
 * Split from index.ts for the module-size hard cap.
 */

// Phase A / Item 5 — the user-question service
// (open-ended user questions + approval delegation).
// The REPL provider is the package-1 default; the
// Tauri / mesh providers land in the adapter.
//
// Chunk 5.1: service + REPL provider.
// Chunk 5.2: ask_user tool + AskForApproval shim.
export {
  createAskForApprovalShim,
  createHostBridgeUserQuestionProvider,
  createReplStdinProvider,
  createUserQuestionService,
  DEFAULT_MULTILINE_SENTINEL,
  makeAskUserTool,
  makeSuggestFollowUpsTool,
  emptyTurnHints,
  hasTurnHints,
  mergeTurnHints,
  type DeferredTask,
  type TurnHints,
  type MakeSuggestFollowUpsToolOptions,
  type AskUserInput,
  type CreateAskForApprovalShimOptions,
  type HostBridgeUserQuestionProviderOptions,
  type HostUserQuestionAsk,
  type HostUserQuestionAnswer,
  type HostUserQuestionRequest,
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
  collaborationModeBlockReason,
  collaborationModePrompt,
  createCollaborationModeState,
  createPlanState,
  filterToolNamesForMode,
  modeForcesReadOnly,
  renderPlanText,
  runReview,
  type CollaborationModeState,
  type ModeKind,
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
  FakeRemoteJobTransport,
  NOOP_REMOTE_JOB_TRANSPORT,
  RemoteJobError,
  formatRemoteJobRef,
  isRemoteJobRef,
  parseRemoteJobRef,
  parseRemotePeerId,
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
  type RemoteJobRef,
  type RemoteJobTransport,
} from "./jobs/index.js";

// R4.14b — exec-world (think local / tools on peer).
export {
  createLocalExecWorld,
  createPeerExecWorld,
  FakeRemoteExecTransport,
  ExecWorldError,
  type ExecReadResult,
  type ExecShellRequest,
  type ExecShellResult,
  type ExecWorld,
  type ExecWorldTarget,
  type RemoteExecTransport,
} from "./exec-world/index.js";

export {
  createFakeFetchProvider,
  createFakeSearchProvider,
  createHttpFetchProvider,
  createBraveSearchProvider,
  createExaSearchProvider,
  createPerplexitySearchProvider,
  createWebRuntime,
  makeWebTools,
  registerWebTools,
  WebError,
  type BraveSearchProviderOptions,
  type ExaSearchProviderOptions,
  type PerplexitySearchProviderOptions,
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
  FakeRemoteTerminalTransport,
  NOOP_REMOTE_TERMINAL_TRANSPORT,
  RemoteTerminalError,
  formatRemoteTerminalRef,
  isRemoteTerminalRef,
  parseRemoteTerminalPeerId,
  parseRemoteTerminalRef,
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
  type RemoteTerminalRef,
  type RemoteTerminalTransport,
} from "./terminal/index.js";

export {
  createSystemPromptRegistry,
  agentsMdSection,
  bashGuidanceSection,
  harnessIdentitySection,
  jobsGuidanceSection,
  personaSection,
  permissionsPolicySection,
  planModeSection,
  readFileGuidanceSection,
  terminalGuidanceSection,
  webSearchGuidanceSection,
  workspaceSection,
  DEFAULT_PROJECT_DOC_FALLBACKS,
  buildAgentSystemPrompt,
  type BuildAgentSystemPromptOptions,
  type PromptAssemblyContext,
  type PromptSection,
  type SystemPromptRegistry,
} from "./system-prompt/index.js";

export {
  assembleTurnContext,
  type AssembleTurnContextOptions,
  type AssembledTurnContext,
} from "./context/turn-context.js";

export {
  RetainedContextStore,
  injectRetainedContext,
  type AddRetainedOptions,
  type RetainedFragment,
  type RetainedKind,
} from "./context/retained.js";

export {
  isEphemeralUserContextText,
  isEphemeralUserMessage,
  injectEphemeralUserContext,
} from "./context/ephemeral-user-context.js";

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

// Phase G / Item 3 — SKILL.md loader (L0 reuse).
// Both codex and deepseek ship a SKILL.md format; one loader
// makes envoy-harness compatible with all three roots
// (`~/.codex/skills/`, `~/.dsh/skills/`, `~/.agents/skills/`,
// project `.envoy/skills/`). The `skill` + `skill_list` tools
// expose skills to the model.
export {
  type FilesystemSkillProviderOptions,
  type SkillDefinition,
  type SkillFrontmatter,
  type SkillProvider,
  type SkillRegistry,
  type SkillRoot,
  type SkillSummary,
  SkillError,
  createFilesystemSkillProvider,
  createSkillRegistry,
  defaultSkillRoots,
  makeSkillListTool,
  makeSkillTool,
  parseFrontmatter,
  registerSkillTools,
  renderSkillContent,
  renderSkillCatalog,
  skillCatalogDigest,
  nextCatalogMessage,
  createSkillCatalogFragment,
  type SkillCatalogOptions,
  isSubsequenceMatch,
  rankSkills,
  type RankSkillsOptions,
  type RankedSkill,
  type SkillRankTier,
} from "./skills/index.js";

// Phase E / Items 10–11 — ACP + SDK protocol
export {
  ACP_PROTOCOL_VERSION,
  attachAcpServer,
  attachSdkServer,
  createFakeSessionBackend,
  createAgentSessionBackend,
  createInProcessJsonRpcPair,
  encodeFrame,
  FrameDecoder,
  installToolPermissionAskHook,
  JsonRpcConnection,
  JsonRpcError,
  JsonRpcErrorCode,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  TeamJobRegistry,
  chainSubtasksToTeamJobs,
  hostLabel,
  mergeTeamJobBoards,
  type AcpServerOptions,
  type AgentSessionBackendOptions,
  type ChainSubtaskJobView,
  type InProcessPair,
  type JsonRpcConnectionOptions,
  type JsonRpcErrorObject,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  type NotificationHandler,
  type ProtocolClusterStatus,
  type ProtocolCommittedMessage,
  type ProtocolDiscoveryEvent,
  type ProtocolPeerHealth,
  type ProtocolPeerInfo,
  type ProtocolPermissionDecision,
  type ProtocolPermissionRequest,
  type ProtocolUserQuestionAnswer,
  type ProtocolUserQuestionRequest,
  type ProtocolPromptResult,
  type ProtocolScoreboardEntry,
  type ProtocolSessionBackend,
  type ProtocolTeamAgentStatus,
  type ProtocolTeamJob,
  type ProtocolToolInfo,
  type RequestHandler,
  type SdkServerOptions,
  type StartPeerSubmitJobInput,
  type StartTeamJobInput,
  type ToolPermissionAskHookOptions,
} from "./protocol/index.js";

// Distributed mesh — static peer endpoint parsing + optional cluster wiring
export {
  parsePeerEndpoint,
  parsePeerEndpointsFromEnv,
  parsePeerEndpointsList,
  type PeerEndpointSpec,
} from "./peers/endpoints.js";
export {
  peersFromConfigLayer,
  resolvePeerEndpoints,
  type ResolvedPeerEndpoint,
  type ResolvePeerEndpointsOptions,
} from "./peers/resolve.js";
export {
  mergeClusterSeams,
  wirePeerCluster,
  type ClusterSeams,
  type PeerDiscoveryMode,
  type WirePeerClusterOptions,
  type WirePeerClusterResult,
} from "./peers/wire-cluster.js";
