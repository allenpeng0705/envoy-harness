/**
 * @envoymesh/envoy-harness-adapter — the reference MAP adapter.
 *
 * **What this package is:** the bridge between envoy-harness
 * (Package 1, mesh-agnostic) and EnvoyMesh's mesh (Package 2
 * protocol + Package "agent-adapter" interface). Implements
 * `AgentAdapter` from `@envoymesh/agent-adapter`.
 *
 * **What this package is NOT:**
 * - Not a fork of envoy-harness. The adapter depends on the
 *   package; the package does NOT depend on the adapter.
 *   (One-way dependency: adapter → harness.)
 * - Not a generic EnvoyMesh library. The adapter is specific
 *   to envoy-harness as the runtime.
 *
 * **Design doc:** `docs/improving-agent-network.en.md` §5.2
 * (in the EnvoyMesh monorepo). Reference implementations:
 * `OpenClawAdapter`, `PiAdapter` in
 * `packages/agent-adapter/src/`.
 *
 * **Stability:** the public surface is `EnvoyHarnessAdapter`
 * (class), `ENVOY_HARNESS_SKILLS`, and the per-adapter
 * helpers. Additive; new fields don't break existing callers.
 */

// F8.0 scaffold — the actual adapter lands in F8.1+. This file
// exists so the package builds, installs, and exports a marker.
// The first real export is the package version.
export const ENVOY_HARNESS_ADAPTER_VERSION = "0.0.0" as const;

// F8.1 — skills catalog + tool mapping.
export {
  ENVOY_HARNESS_SKILLS,
  ENVOY_HARNESS_VERSION,
  getToolsForSkill,
  isReadOnlySkill,
  type EnvoyHarnessSkillId,
  type EnvoyHarnessToolName,
} from "./skills.js";

// F8.3 — local ↔ wire type translation.
export {
  TOOL_CALL_SCHEMA_REF,
  TOOL_RESULT_SCHEMA_REF,
  localToWireBlock,
  localToWireContent,
  localToWireMetrics,
  localToWireResult,
  type ToolCallData,
  type ToolResultData,
} from "./translation.js";

// F8.2 + F8.4 + F8.5 + F8.6 — EnvoyHarnessAdapter class.
export {
  EnvoyHarnessAdapter,
  defaultBuildAgentFactory,
  buildEnvoyHarnessAdapterWithCrossVerify,
  type BuildAgentFn,
  type BuildEnvoyHarnessAdapterWithCrossVerifyInput,
  type EnvoyHarnessAdapterInput,
  type SignResultFn,
} from "./adapter.js";

// F8.4+ — default SignResult that uses real Ed25519 via
// @envoymesh/identity.
export {
  defaultSignResult,
  defaultSignResultFromKeyPair,
} from "./signing.js";

// F8.6+ — wire the local verifier rules.
// F9.5+ — cross-agent verification (CrossVerifyFn + defaultCrossVerify).
export {
  defaultCrossVerify,
  runLocalVerifier,
  runLocalVerifierOnLocal,
  type CrossVerifyFn,
} from "./verify.js";

// F10.3.2 — cross-node `MeshSubmitter` for sub-agents on remote
// worker nodes. The transport is host-injected; the adapter
// doesn't ship a default (the real mesh protocol lives in
// EnvoyMesh, not here).
export {
  RemoteMeshSubmitter,
  type RemoteMeshSubmitterOptions,
  type RemoteSubmitterTransport,
} from "./remote-mesh-submitter.js";

// D6 — the peer-backed transport: a `RemoteMeshSubmitter` over the
// standalone peer protocol (peer cluster as a mesh node's execution
// pool). The same seam hosts the v2.2 libp2p fabric transport.
export {
  createPeerRemoteSubmitterTransport,
} from "./peer-transport.js";

// Phase 8 Step 2 — cross-runtime (same-node) `MeshSubmitter`
// for sub-agents that should run on a different local runtime
// (Built-in OpenClaw today; future runtimes slot into
// `LocalRuntimeBridge.submitToX`). The host (EnvoyMesh's
// `LocalRuntimeRegistry`) implements the bridge. The adapter
// itself imports no per-runtime package — same DI shape as
// `RemoteSubmitterTransport`.
export {
  LocalCrossRuntimeSubmitter,
  type LocalCrossRuntimeSubmitterOptions,
  type LocalRuntimeBridge,
} from "./local-cross-runtime-submitter.js";

// Phase 8 Step 2 — re-export the `MeshSubmitter` types from
// envoy-harness so the host (EnvoyMesh's `LocalRuntimeRegistry`)
// can import the types from a single dep — it doesn't need
// to ALSO add `@envoymesh/envoy-harness` as a direct dep just
// to type the `LocalRuntimeBridge` interface.
//
// **Why here, not in envoy-harness itself:** the bridge is
// the seam that knows about both the harness types and the
// mesh. Re-exporting the type surface from the bridge gives
// the host one canonical import path for cross-runtime
// sub-agent types.
//
// **Stability:** pure re-exports. No type widening, no
// field renaming. Additive; new exports from envoy-harness
// can be re-exported here in any order.
export type {
  MeshSubmitter,
  SubagentInput,
  SubagentResult,
  SubagentRecord,
  RoutingHint,
  SubagentResultSigner,
  AgentRuntime,
} from "@envoymesh/envoy-harness";

// Phase 8 / Step 3 — B-class skills (canonical in the bridge).
// The bridge owns the canonical impl for the 3 mesh-touching
// capabilities (sponsor-friend / peer-list / relay-status).
// Both envoy-harness and OpenClaw consume from the bridge
// through their respective adapter.
export {
  listPeersBridge,
  listPeersTool,
  relayStatusBridge,
  buildRelayStatusTool,
  runSponsorFriendBridge,
  sponsorFriendTool,
  __resetActiveSponsorLoopsForTests,
  type BClassPeerListDeps,
  type PeerListResult,
  type PeerListEntry,
  type BClassRelayStatusDeps,
  type BClassRelayStatusResult,
  type BClassRelaySnapshot,
  type BClassAuditEventLike,
  type BClassSponsorFriendDeps,
  type BClassSponsorFriendMeshDeps,
  type BClassSponsorFriendProfileDeps,
  type BClassSponsorFriendConfigDeps,
  type BClassSponsorFriendAuditDeps,
  type BClassPersistedNodeConfig,
  type BClassHelloProfile,
  type BClassResolvedSponsorFriend,
  type BClassSponsorFriendResult,
} from "./b-class-skills/index.js";

// Phase G — mesh credential + remote session transport seams
export {
  createMeshCredentialsProvider,
  type MeshCredentialsTransport,
} from "./mesh-credentials.js";
export {
  loadRemoteSession,
  type RemoteSessionProjection,
  type RemoteSessionRef,
  type RemoteSessionTransport,
} from "./remote-session.js";
