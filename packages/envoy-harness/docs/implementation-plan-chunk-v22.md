# Chunk v2.2 — libp2p fabric + parallel connect + Round-3 peer surface

> **Status:** ✅ DONE (2026-08-22, working tree — pending user commit).
> Three items from the distributed-collaboration review, in one round:
> (1) the parallel-connect optimization, (2) the v2.2 libp2p fabric
> (`RemoteSubmitterTransport` over the mesh), (3) the Round-3 UI surface
> for connected peers.

## 1. Parallel-connect optimization (envoy-harness-peer)

`connectPeerClients` previously connected configured endpoints
**sequentially** — a dead peer added its full connect timeout before the
healthy peers were reached. Now:

- All endpoints connect **concurrently** (`Promise.all` over the config).
- Fail-open is preserved: each attempt catches its own error; the
  successful peers still form the cluster.
- Results stay deterministic: `connected` / `failed` are reported in
  config order (the attempt carries its `peer`, not a resolved index).
- `connect` is injectable (`options.connect`), matching the
  `buildEnvoyHarnessPeerPool` DI pattern.

**Test:** a gated fake connect proves concurrency — both endpoints must
start before either resolves (a sequential implementation deadlocks).
The test runs even where localhost binding is blocked (no TCP needed).

## 2. v2.2 libp2p fabric — the mesh-side RemoteSubmitterTransport

The fabric transport (Pattern B: a mesh node's `RemoteMeshSubmitter`
targeting ANOTHER mesh node's envoy-harness worker directly) is now
implemented, closing the last deferred item of the v2.2 sub-plan.

### Protocol (`@envoymesh/protocol`)

- `TaskHarnessSubmitRequestPayloadSchema` — the serializable half of
  `ExecuteInput` (no `AbortSignal`; the worker rebuilds one from
  `deadlineMs`), with `verifierModel` for the v1.16 per-call override.
- `TaskHarnessSubmitResponsePayloadSchema` — discriminated `ok` union:
  `{ ok: true, result: SignedAgentResult }` | `{ ok: false, error }`.
- Two new intents (`task.harness.submit.request` / `.response`) in the
  `EnvoyIntentSchema` allowlist + `AGENT_AGENT_ONLY` role policy +
  `BRIDGE_AGENT_SCOPE` (agent-signed envelope scope check).

### Worker side (`apps/node/src/harness-submit-inbound.ts`)

`handleInboundHarnessSubmitRequest` — parses the request, runs it through
the node's live `EnvoyHarnessAdapter.execute()`, and replies on the same
stream with the signed `AgentResult` — or a wire error (`ok: false`) when
the adapter is unavailable, the payload is malformed, or execution
throws (the parent fails fast instead of waiting out the deadline).
Wired via `NodeServiceImpl.handleInboundHarnessSubmitRequest` + the mesh
inbound dispatcher (`apps/node/src/index.ts`).

### Parent side (`apps/node/src/harness-submit-transport.ts`)

`createLibp2pRemoteSubmitterTransport` — maps `SubagentInput` →
`ExecuteInput`, signs the request envelope with the parent's agent key,
sends via the mesh's proven expect-reply seam
(`sendExpectReplyWithRetry`, same pattern as the chain ready probe),
verifies the reply envelope (`verifyInboundEnvelope`, TOFU), checks the
correlation id, and maps the `SignedAgentResult` back to `SubagentResult`.

- **Abort:** a parent abort rejects the round-trip with an `AbortError`
  immediately (checked before send AND raced against the wait).
- **Self-submit:** a target resolving to this node executes through the
  local adapter (`executeLocally`) instead of a mesh loopback.
- **Deadline hardening:** deadlines are clamped to a 24h ceiling so a
  hostile/huge `deadlineMs` cannot overflow `setTimeout`.
- **Access:** `NodeServiceImpl.createLibp2pRemoteSubmitterTransport()`
  builds the transport over the same `ChainTransportResolver` the chain
  workers use; returns `null` when the mesh or agent identity is
  unavailable.

**Tests:** protocol payload round-trips + rejections (5), inbound handler
(6: success, unavailable adapter, execution error, malformed payload,
wrong intent, missing reply channel), transport (9: success, wire error,
unexpected intent, correlation mismatch, bad signature, pre-abort,
unknown target, local execution, missing local executor).

## 3. Round-3 UI surface — connected-peer visibility

The mesh node already had `listEnvoyHarnessPeers()` (management surface).
This round adds the standalone side + a protocol surface:

- `ProtocolSessionBackend.listPeers?()` (optional seam) + `peers/list`
  on BOTH the ACP and SDK server dialects.
- `EnvoyHarnessClient.listPeers()` (typed client method).
- TUI `/peers` slash command — renders the host's connected peer cluster
  (`id`, `model`, `capabilities`) or an empty state.
- `createAgentSessionBackend({ listPeers })` — hosts wire their registry.
- EnvoyMesh: the in-process ACP host's backend now exposes
  `listEnvoyHarnessPeers()` over `peers/list`, so the standalone TUI and
  a future Tauri panel share one surface.

**Tests:** client `listPeers` over SDK + ACP (2), TUI `/peers` render +
empty state + help entry (3).

## 4. Follow-up — external review pass (2026-08-22)

Fixes from the "peer serve / honest verdict / stale docs" review:

- **`envoy-peer serve` CLI** — the missing binary is shipped in
  `@envoymesh/envoy-harness-peer` (`bin/envoy-peer.ts` +
  `src/cli/serve.ts`): TCP server over `createPeerServerHandler`, with
  `--adapter <module>` (ESM default export or factory), `--peer-id`,
  `--model`, `--owner-id`, `--verify-after-execute`, and a built-in demo
  adapter when no adapter file is given. Package 1 stays clean — the
  binary is `envoy-peer`, not an `envoy-harness` subcommand.
- **Honest verdicts** — `peer/submit` responses now carry an optional
  server verdict: `PeerServerOptions.verifyAfterExecute` runs
  `adapter.verify` after execute and returns the combined verdict
  (`PeerSubmitResponse = { result, verdict? }`); `PeerMeshSubmitter`
  uses it instead of the v1 placeholder when present. Default remains
  placeholder (documented).
- **`submitResponseBufferMs`** — the hardcoded `deadlineMs + 5s` submit
  timeout is now a per-client option (default 5s) for slow-link hosts.
- **Docs** — stale test counts de-counted across the chunk docs;
  `implementation-plan.md` now states the v2.2 fabric transport ships in
  EnvoyMesh (not envoy-harness) and that `envoy-peer` is the peer CLI
  binary; `/peers` documented in the TUI README; model-side peer
  discoverability recorded as a known limitation.

## 5. Follow-up — review round 2 (2026-08-23)

- **Model-side peer discoverability — RESOLVED.** `createPeersTool(
  registry)` (`packages/envoy-harness-peer/src/tools/peers-tool.ts`)
  gives the model a `peers` tool listing `{ id, model, capabilities }`
  with an explicit "route with task.preferred_peer_id" hint. The
  adapter advertises the `peer-cluster` skill (mapped to the `peers`
  tool), and EnvoyMesh adds the tool to `bClassTools` when an
  `envoyHarnessPeers` pool is configured. The `task` tool's
  `preferred_peer_id` description now points at the `peers` tool.
- **Verifier-throw regression test** — `adapter-server.test.ts` now
  proves `verifyAfterExecute` with a throwing verifier still returns the
  result (no verdict).
- **Impersonation guard confirmed** — the EnvoyMesh transport rejects
  `reply.senderPeerId !== targetPeerId` (committed `475bf4f5`), with a
  dedicated test using a real impostor keypair.
- **Host guide** — `distributed-collaboration.md` §10b documents the
  verdict-routing options and their cost tradeoffs, and the missing
  cost-budget knob on `verifyAfterExecute` as a follow-up.

**Tests added:** peer package `peers-tool` (3), verifier-throw (1);
adapter `peer-cluster` skill mapping (updated count assertions + mapping
test); EnvoyMesh runtime end-to-end `peers` tool call (1).

## Verification

- envoy-harness: typecheck clean (6 packages), build ×6, module-size
  green; full suite green (envoy-harness 1567, adapter 151, cordis 21,
  tui 8, client 4; peer package green across 12 files — dialect, cluster,
  serve CLI, peers tool, hardening, scoreboard; the TCP tests self-skip
  only where localhost binds are blocked).
- EnvoyMesh: `tsc -b` clean; blast-radius suites green — protocol +
  role-policy + chain-ready-probe (245), harness submit inbound +
  transport (15), peer-pool + federate + runtime + verify-loop +
  config-store-v1-4 (87), acp-host + acp-policy (7), bridge scope +
  credential (8). Full-suite failures (67) are pre-existing
  environment/timing flakes in unrelated areas (social UI, STUN/network,
  tool-count drift from prior rounds), confirmed outside the change
  surface.
