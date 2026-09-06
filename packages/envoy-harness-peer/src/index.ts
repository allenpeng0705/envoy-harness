/**
 * @envoymesh/envoy-harness-peer — standalone peer collaboration.
 *
 * D2: JSON-RPC transport + `PeerClient` + `PeerMeshSubmitter` over the
 * harness's shared framing. Grows into the full MAP-over-JSON-RPC server
 * (D3) per `docs/distributed-collaboration.md`.
 */

export {
  PeerClient,
  type PeerClientOptions,
} from "./client.js";
export {
  PeerMeshSubmitter,
  type PeerMeshSubmitterOptions,
} from "./submitter.js";
export {
  createPeerServerHandler,
  type PeerServerOptions,
} from "./server.js";
export {
  PeerRegistry,
  type PeerEntry,
} from "./registry.js";
export {
  createPeerTeamExecutor,
  type PeerTeamExecutorOptions,
} from "./team.js";
export {
  createCrossInstanceVerifier,
  type CrossInstanceVerifier,
  type CrossVerifyOutcome,
  type CrossVerifyRequest,
} from "./verify.js";
export {
  PeerScoreboard,
  combinePeerVerdicts,
  type PeerReputation,
  type ScoreboardMergeResult,
} from "./scoreboard.js";
export {
  pullPeerScoreboards,
  type PullPeerScoreboardsOptions,
  type PeerScoreboardPullResult,
} from "./scoreboard-pull.js";
export {
  createVerifiedScoreKeeper,
  type VerifyAndRecordRequest,
} from "./verify-score.js";
export {
  signedResultToSubagentResult,
  subagentInputToExecuteInput,
} from "./mapping.js";
export {
  createInProcessPeerPair,
  type InProcessPeerPair,
} from "./pair.js";
export {
  PEER_PING_METHOD,
  PEER_VERIFY_METHOD,
  PEER_MANIFEST_METHOD,
  PEER_SUBMIT_METHOD,
  PEER_SUBMIT_CONTINUABLE_METHOD,
  PEER_SEND_METHOD,
  PEER_INTERRUPT_METHOD,
  PEER_CLOSE_METHOD,
  PEER_STATUS_METHOD,
  PEER_WAIT_SETTLE_METHOD,
  PEER_SCOREBOARD_LIST_METHOD,
  PEER_JOBS_FETCH_METHOD,
  PEER_JOBS_READ_METHOD,
  PEER_JOBS_KILL_METHOD,
  PEER_JOBS_LIST_METHOD,
  PEER_EXEC_READ_METHOD,
  PEER_EXEC_WRITE_METHOD,
  PEER_EXEC_SHELL_METHOD,
  type PeerPingResult,
  type PeerSubmitResponse,
  type PeerSubmitContinuableParams,
  type PeerSubmitContinuableResult,
  type PeerTaskControlParams,
  type PeerTaskStatusResult,
  type PeerJobsFetchParams,
  type PeerJobsKillParams,
  type PeerExecReadParams,
  type PeerExecWriteParams,
  type PeerExecShellParams,
  type WireExecuteInput,
} from "./messages.js";
export { PeerContinuableTaskRegistry, SETTLED_TASK_TTL_MS } from "./continuable-peer-tasks.js";
export {
  createPeerRemoteJobTransport,
  peerJobRef,
  type PeerRemoteJobTransportOptions,
} from "./jobs-rpc.js";
export {
  createPeerRemoteExecTransport,
  type PeerRemoteExecTransportOptions,
} from "./exec-rpc.js";
export {
  wrapEnvelope,
  unwrapEnvelope,
  canonicalPeerPayload,
  type PeerEnvelope,
  type PeerSigner,
  type PeerVerifier,
} from "./envelope.js";
export type { PeerEvent, PeerEventSink } from "./events.js";
export {
  connectPeerClient,
  type TcpPeerClient,
  type TcpPeerClientOptions,
} from "./tcp.js";
export {
  connectPeerClients,
  createPeerClusterSubmitter,
  type ConnectPeerClientsResult,
  type PeerClusterSubmitterOptions,
  type PeerEndpointConfig,
} from "./cluster.js";
export {
  ManagedPeerCluster,
  type ConnectPeerResult,
  type ManagedPeerClusterOptions,
} from "./managed-cluster.js";
export {
  StaticDiscoverySource,
  FakeDiscoverySource,
  MeshFeedDiscoverySource,
  MdnsDiscoverySource,
  CompositeDiscoverySource,
  type DiscoverySource,
  type DiscoverySourceKind,
  type DiscoveredPeer,
  type DiscoveryAnnouncement,
  type DiscoveryListener,
} from "./discovery.js";
export {
  createDiscoveryRail,
  type DiscoveryRail,
  type DiscoveryRailOptions,
} from "./discovery-rail.js";
export {
  parseServeArgs,
  startPeerServer,
  createDemoAdapter,
  loadAdapterFromFile,
  runPeerServeCli,
  PEER_SERVE_HELP,
  type PeerServeArgs,
  type PeerServeIo,
  type StartedPeerServer,
} from "./cli/serve.js";
export { createPeersTool, type PeersToolOptions } from "./tools/peers-tool.js";
export {
  createPeerPoolStatusBackend,
  clusterStatusFromConnect,
  type ConnectResultLike,
  type PeerHealthInfo,
  peerToInfo,
} from "./status.js";
export {
  aggregateScoreboard,
  aggregateVerdicts,
  buildHealthProvider,
  createPeerUiBackend,
  parsePeerUiArgs,
  runPeerUiCli,
  PEER_UI_HELP,
  type PeerUiArgs,
  type PeerUiBackend,
  type PeerUiBackendOptions,
  type PeerUiIo,
  type PeerUiPeerArg,
} from "./cli/ui.js";
export {
  TeamJobRegistry,
  chainSubtasksToTeamJobs,
  hostLabel,
  mergeTeamJobBoards,
  type ChainSubtaskJobView,
  type StartPeerSubmitJobInput,
  type StartTeamJobInput,
} from "./team-jobs.js";
export { createTeamJobTracker } from "./team-job-tracker.js";
