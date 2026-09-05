# Chunk R4.9a — Continuable local sub-agents

> **Status:** IMPLEMENTED (2026-09-05).
> Part of Round 4 D-Refine ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).
> Design: [`distributed-collaboration.md`](./distributed-collaboration.md) §11.2.

## Goal

dsh-style continuable sub-agents on a single instance: spawn without
blocking the parent forever on one fire-and-await, with inbox
(`send`), `interrupt`, and `waitSettle`, plus a settlement notice.

Peer path is **R4.9b** (same handle shape later).

## Changes

### Core

- `src/subagent/continuable.ts` — `ContinuableSubagentHandle`,
  `ContinuableSubagentRegistry` (inbox pump, settle waiters, deadline)
- `LocalMeshSubmitter.submitContinuable` / `getHandle`
- `LocalMeshSubmitter.submit()` — now `submitContinuable` +
  `autoSettleAfterIdle: true` + `waitSettle` (backward compatible)
- `onSubagentSettle` option on submitter / per-call

### Semantics

| API | Behavior |
|---|---|
| `submitContinuable` | Returns handle immediately; objective runs in background |
| `send(msg)` | Enqueue follow-up; runs after current turn |
| `close()` | No more inbox; settle after drain |
| `interrupt()` | Abort in-flight; settle failed |
| `waitSettle()` | Await final `SubagentResult` (idempotent) |
| `autoSettleAfterIdle: true` | Settle when inbox empty (blocking `submit` path) |
| `autoSettleAfterIdle: false` | Stay open until `close` / `interrupt` / deadline |

## Tests

- `test/subagent-continuable.test.ts` — round-trip send+close,
  interrupt, blocking submit, double waitSettle
- Existing `test/subagent-local.test.ts` still green

## Accept

- [x] Local-only round-trip (no peer package)
- [x] `send` / `interrupt` / `waitSettle`
- [x] Settlement notice via `onSubagentSettle`
- [x] Hermetic scripted model tests

## Out of scope

- R4.9b peer interrupt / status RPC
- Model-facing `task` background mode / `task_continue` tool
- ACP `session/subagent/*` methods
- Firing `SubagentStop` hook (defined elsewhere; wire later)
