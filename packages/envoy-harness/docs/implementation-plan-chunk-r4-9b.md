# Chunk R4.9b — Continuable peer tasks

> **Status:** IMPLEMENTED (2026-09-05).
> Part of Round 4 D-Ops ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).
> Design: [`distributed-collaboration.md`](./distributed-collaboration.md) §11.2.
> Local counterpart: [`implementation-plan-chunk-r4-9a.md`](./implementation-plan-chunk-r4-9a.md).

## Goal

Same continuable sub-agent handle as R4.9a, over the standalone peer
dialect — `peer/submit` stays fire-and-await; new RPCs spawn, inbox,
interrupt, and status without blocking the parent on spawn.

## Changes

### Peer package

- `src/messages.ts` — `peer/submitContinuable`, `peer/send`,
  `peer/interrupt`, `peer/close`, `peer/status` + wire types
- `src/continuable-peer-tasks.ts` — server registry (inbox pump,
  AbortSignal into `adapter.execute`, correlationId idempotency)
- `createPeerServerHandler` — routes the new methods
- `PeerClient` — typed RPCs + `toWireExecuteInput`
- `PeerMeshSubmitter.submitContinuable` / `getHandle` —
  `ContinuableSubagentHandle` over status polling

### Semantics

| API | Behavior |
|---|---|
| `peer/submitContinuable` | Register + start; returns immediately; same `correlationId` → `idempotent: true` |
| `peer/send` | Enqueue follow-up objective |
| `peer/close` | No more inbox; settle after drain |
| `peer/interrupt` | Abort in-flight execute; settle failed |
| `peer/status` | Lifecycle + optional settled `PeerSubmitResponse` |
| Blocking `peer/submit` | Unchanged |

## Tests

- `test/continuable-peer.test.ts` — send+close round-trip, interrupt,
  correlationId idempotency, blocking submit regression

## Accept

- [x] Peer interrupt aborts in-flight execute
- [x] correlationId idempotent
- [x] Same handle shape as R4.9a (`send` / `interrupt` / `waitSettle`)
- [x] Hermetic stub-adapter tests

## Out of scope

- Model-facing `task` background mode / `task_continue`
- ACP `session/subagent/*` methods
- Push notify for settle (client polls `peer/status`)
