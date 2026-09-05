# Chunk R4.4 — Session projections / turn outline

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 4 D-Refine ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).

## Goal

Cheap turn-rail data without full transcript replay — turn boundaries
and tool counts for TUI/EHUI / `/turns`-style UX.

## Changes

### Core

- `src/session/turn-outline.ts` — `TurnOutline` / `TurnOutlineEntry`,
  `buildTurnOutlineFromMessages` (full-replay reference),
  `TurnOutlineRegistry` (incremental), `loadTurnOutlineFromFile`
- ACP/SDK `session/outline`
- Fixture `test/fixtures/sessions/multi-turn.jsonl`

### Turn rule

A turn starts at each `user` message and includes following assistant /
tool / system messages until the next user or EOF. `toolCallCount` /
`toolNames` come from assistant `tool_call` blocks.

## Tests

- `test/session/r4-4-turn-outline.test.ts` — incremental === full
  replay on fixture

## Accept

- [x] Outline matches full replay on fixture log

## Out of scope

- Sidecar outline cache file
- Replacing mesh `/trace` (U5 discovery) — use `session/outline` / future `/turns`
- design §16 SessionEvent stream rewrite
