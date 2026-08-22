# Chunk R2 — mesh-shaped fan-out + production peer transport

> **Status:** ✅ DONE (2026-08-22, working tree — pending user commit).
> Round 2 of the **distributed-collaboration** major feature
> (`docs/distributed-collaboration.md`; `implementation-plan.md`).

## Goal

Prove Pattern A end-to-end: a mesh node's chain worker fans out to a
standalone peer cluster as its **execution pool**, and add the production
TCP transport for standalone peers.

## Changes

**Peer package (`@envoymesh/envoy-harness-peer`)**
- `tcp.ts` — `connectPeerClient({ host, port, signer?, onEvent? })`: the
  production TCP transport (connect timeout, socket lifecycle). Reuses the
  `PeerClient` + `JsonRpcConnection`.

**EnvoyMesh runtime (`apps/node/src/agent-runtime-envoy/runtime.ts`)**
- `CreateRealEnvoyHarnessRuntimeOptions.innerSubmitter?: MeshSubmitter` —
  the sub-agent execution pool is injectable. Default: `LocalMeshSubmitter`
  (same machine). A host can pass `RemoteMeshSubmitter` over
  `createPeerRemoteSubmitterTransport` so the worker's `task` tool fans out
  to a peer cluster.

**apps/node** — new dep `@envoymesh/envoy-harness-peer` (link).

## Tests

- **Peer package**: `connectPeerClient` over loopback TCP (ping + execute).
- **EnvoyMesh integration** (`agent-runtime-envoy-runtime.test.ts`): a
  chain worker (D1 executor) whose runtime's `innerSubmitter` is a
  peer-backed `RemoteMeshSubmitter`; a scripted model emits a `task` call,
  the sub-agent lands on the in-process peer cluster (the peer's adapter
  execute is invoked), and the worker's final partial flows back through
  the chain worker. This is the hermetic proof of Pattern A.

## Verification

- EnvoyMesh: `tsc -b` clean, 450 hermetic tests green.
- envoy-harness: typecheck clean, build ×6, module-size green (247 files);
  peer 21 passed (loopback TCP verified), full suite 1767.

## Next

Round 2 remaining (optional): the mesh node's persisted config wiring for
peer endpoints (static discovery), and a Tauri/UI surface to manage peers.
Round 3: federation into the mesh arbitration store + the libp2p transport.
