# Chunk R4.11 — Federated scoreboard pull (v1)

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 4 D-Ops ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).
> Design: [`distributed-collaboration.md`](./distributed-collaboration.md) §D5 / scoreboard federation.

## Goal

Peers exchange `VerdictEntry` reputation records: peer A records locally;
peer B pulls and merges idempotently. Replaces the “LocalPeerSource stub
only” gap for v1 federation (VerdictEntry path on the peer package).

## Changes

### Peer package

- `peer/scoreboard/list` RPC (`PEER_SCOREBOARD_LIST_METHOD`)
- `PeerServerOptions.scoreboard` — optional `PeerScoreboard` exposed by list
- `PeerClient.listScoreboard()`
- `PeerScoreboard.merge` / idempotent `record` keyed by
  `(chainId, subtaskId, issuedBy)`
- `pullPeerScoreboards({ registry, local })` — fail-open per peer

## Accept

- [x] Peer A records → peer B pulls via registry
- [x] Second pull skips duplicates (`added: 0`, `skipped: N`)
- [x] Hermetic in-process test (`test/scoreboard-pull.test.ts`)

## Out of scope

- Harness `FederatedScoreboard` / self-evolve `ScoreboardEntry` schema
  (different shape; remains Package 1)
- Push / gossip / signed federation policy
- Automatic periodic pull scheduling
