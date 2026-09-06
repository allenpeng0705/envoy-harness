# Chunk R4.14 — Unify chain job board ↔ peer `team/jobs`

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 4 D-Mesh ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).

## Goal

One ACP `ProtocolTeamJob` board for Scenario A (mesh chain worker) and
Scenario B (standalone peer `TeamJobRegistry`).

## Changes

### Package 1

- `src/protocol/team-job-board.ts` — canonical `TeamJobRegistry`,
  `hostLabel`, `chainSubtasksToTeamJobs`, `mergeTeamJobBoards`
- Re-exported from protocol + package root

### Peer package

- `team-jobs.ts` re-exports Package 1 (no second schema)

## Accept

- [x] Chain subtasks → same `ProtocolTeamJob` shape as mesh U4
- [x] Merge chain + peer boards (later `jobId` wins)
- [x] Peer tests still green via re-export

## Out of scope

- Switching EnvoyMesh `chainWorkerSubtasksToTeamJobs` to the shared
  helper (drop-in; do in EnvoyMesh when convenient)
- R4.14b exec-world on peer
