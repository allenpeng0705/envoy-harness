# Chunk U4 — EnvoyMesh host wiring for the dedicated UI

> **Status:** ✅ DONE (2026-08-23, working tree — pending user commit).
> The desktop/EnvoyGo *panels* remain Tauri-team work (deferred
> v1.12/v1.15); this chunk completes the host side of the contract so the
> panels have real data.

## What shipped (EnvoyMesh)

The in-process ACP host's backend (used by `ENVOY_HARNESS_TRANSPORT=acp`
and the Pi-coding-backend path) now serves every dedicated-UI method:

- `listPeers` / `clusterStatus` / `routePeer` — from the configured
  `envoyHarnessPeers` pool via `createPeerPoolStatusBackend` (peer
  package; added U3).
- `teamJobs` — **new**: the local chain worker's subtasks grouped per
  chain (`chainWorkerSubtasksToTeamJobs`), so `/team` shows live
  chain-worker jobs.
- `scoreboardSummary` — **new**: every signed verdict across all chain
  arbitration stores, aggregated per `(workerPeerId, skillId)`
  (`listAllVerdictEntries` + the peer package's `aggregateVerdicts`).

Pure mappers (`chainWorkerSubtasksToTeamJobs`, `listAllVerdictEntries`)
are exported from `node-service-chain-orchestration.ts`; `aggregateVerdicts`
is shared with the standalone `envoy-peer ui`.

## Tests

`apps/node/test/envoy-harness-ui-mappers.test.ts` — subtask→job grouping
and verdict aggregation (2 suites). Peer package `aggregateVerdicts`
shares the peer-ui aggregation coverage.

## Verification

- EnvoyMesh: `tsc -b` clean (forced full recheck), mappers + ACP-host
  suites green.
- envoy-harness: full suite green (below).

## Next

U5 polish (search view, trace view, accent theme) — see
`implementation-plan-chunk-u5.md`. The Tauri team consumes the same
ACP/SDK methods for desktop panels.
