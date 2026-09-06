# Chunk R5.4 — Adapter job/exec transport factories

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 5 ([`implementation-plan-round-5.md`](./implementation-plan-round-5.md)).

## Goal

Give EnvoyMesh hosts the same registry-routed factories for jobs and
exec that already exist for submit (`createPeerRemoteSubmitterTransport`).

## Changes

- `createPeerRemoteJobTransportFromRegistry(registry)`
- `createPeerRemoteExecTransportFromRegistry(registry)`
- Exported from `@envoymesh/envoy-harness-adapter`
- Doc note in `envoy-harness-ui.md` for host mapper swap
- Hermetic adapter tests

## Accept

- [x] Registry routes job/exec RPCs to the correct peer client
- [x] Missing peer → typed NOT_FOUND error

## Out of scope

- EnvoyGo React panel rewrite
- Libp2p job fabric
