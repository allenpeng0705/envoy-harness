# Chunk D6 — EnvoyMesh combination (peer cluster as an execution pool)

> **Status:** ✅ DONE (2026-08-22, working tree — pending user commit).
> Part of the **distributed-collaboration** major feature
> (`docs/distributed-collaboration.md`; `implementation-plan.md`
> §"Distributed collaboration").

## Goal

Combine the two scenarios: a mesh node's `RemoteMeshSubmitter` targets a
standalone envoy-harness peer cluster through the `RemoteSubmitterTransport`
seam (Pattern A — the mesh orchestrates, the peers execute). The same seam
hosts the v2.2 libp2p fabric later.

## Changes

- `@envoymesh/envoy-harness-adapter` — `createPeerRemoteSubmitterTransport
  (registry)`: a `RemoteSubmitterTransport` whose `send(input,
  targetPeerId, signal)` resolves the peer (`registry.get` then
  `registry.route`) and submits via `PeerMeshSubmitter`. New dep:
  `@envoymesh/envoy-harness-peer` (link; no cycle — the peer package
  doesn't import the adapter).
- EnvoyMesh `docs/agent-harness-integration-v2-2-remote-submitter-transport.md`
  — D6 note: the seam now has two implementations (peer JSON-RPC shipped;
  libp2p fabric later).

## Crypto (v1)

The peer protocol uses shared-token auth; the worker's
`SubagentResult.signature` rides through from the peer adapter's
`SignedAgentResult`. Ed25519 envelope signing/verification is v2 — the
same seam, a stronger transport.

## Tests (+2, adapter)

- A `RemoteMeshSubmitter` over the peer transport + in-process peer pair
  submits to the cluster and returns the peer's result (signature
  passthrough).
- Unknown target peer → clear error.

## Verification

- Adapter typecheck + peer-transport tests green; full monorepo
  typecheck/test/build green; module-size gate green.

## Next

Chunk D7 — hardening + refinement: Ed25519 signed envelopes, peer
observability in the trace/telemetry sinks, static config → discovery,
federation seams.
