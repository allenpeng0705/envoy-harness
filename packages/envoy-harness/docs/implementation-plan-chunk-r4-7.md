# Chunk R4.7 — Live `team/jobs` on standalone peer path

> **Status:** IMPLEMENTED (2026-09-05).
> Part of Round 4 D-Ops ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).

## Goal

ACP `team/jobs` non-empty outside EnvoyMesh so TUI `/team` works on
Scenario B (`--acp --peers`, `envoy-peer ui`).

## Changes

### Peer package

- `src/team-jobs.ts` — `TeamJobRegistry` (team runs + peer submits)
- `src/team-job-tracker.ts` — bind registry to `Team` lifecycle hooks
- `createPeerUiBackend` — always exposes `teamJobs()`; returns
  `teamJobRegistry`
- `ManagedPeerCluster` — shared `teamJobRegistry`
- `createPeerClusterSubmitter` — optional `teamJobRegistry` records submits

### Package 1

- `TeamOptions` lifecycle: `onTeamStart` / `onAgentStart` /
  `onAgentFinish` / `onTeamFinish` (R4.7 + R4.8 reuse)

`wirePeerCluster` already forwarded `teamJobs` when present — no change.

## Tests

- `envoy-harness-peer/test/team-jobs.test.ts` — registry, UI seam,
  tracker + `Team.runOnce`

## Accept

- [x] Same `ProtocolTeamJob` shape as mesh U4
- [x] Peer UI backend returns jobs after registry activity
- [x] Hermetic tests without EnvoyMesh

## Out of scope

- Auto-wiring team CLI to tracker (host composes `createTeamJobTracker`)
- R4.14 chain-board ↔ peer jobs unification
