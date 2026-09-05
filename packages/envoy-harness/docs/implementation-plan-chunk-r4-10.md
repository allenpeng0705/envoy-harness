# Chunk R4.10 — Verify session budget

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 4 D-Ops ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).
> Design: [`distributed-collaboration.md`](./distributed-collaboration.md) §10b.

## Goal

Cap expensive verifications per session; skip with an **explicit reason**
and telemetry-friendly event when budget is exhausted.

## Changes

### Package 1

- `src/verifier/budget.ts` — `VerifySessionBudget` (`tryReserve` / `consume` / `take`)

### Peer package

- `createPeerServerHandler` accepts `maxVerificationsPerSession` (alias
  `maxVerifyAfterExecute`) or a shared `verifyBudget`
- `verifyAfterExecute` and `peer/verify` share the budget
- `PeerSubmitResponse.verifySkipped: { reason }` on skip
- `onEvent` error field carries the skip reason (telemetry)

## Accept

- [x] N+1st verify skipped with explicit reason
- [x] Hermetic Package 1 + peer tests

## Out of scope

- “Skip when remaining USD budget < X” (numeric cost threshold)
- EnvoyMesh adapter auto-wiring of host session budget
