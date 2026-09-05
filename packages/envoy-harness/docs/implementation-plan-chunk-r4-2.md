# Chunk R4.2 — Retained context across compaction

> **Status:** IMPLEMENTED (2026-09-05).
> Part of Round 4 D-Refine ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).

## Goal

Codex/Guardian-style: explicit size-capped facts (user answers,
verified notes) survive drop-oldest / summarize / budget compaction
and are re-injected into the transcript.

## Changes

- `src/context/retained.ts` — `RetainedContextStore`,
  `injectRetainedContext` (user block after system message)
- `Agent.retainContext` / `listRetainedContext` / `clearRetainedContext`
- `Agent.compact` / `compactWithSummary` / `compactWithBudget`
  re-inject retained after rewriting the transcript
- Default token budget 4_000 (FIFO eviction)

## Tests

- `test/retained-context.test.ts` — store budget eviction, inject
  placement, Agent.compact preserves retained fact

## Accept

- [x] Compact preserves retained items
- [x] Hermetic unit tests (no LLM)

## Out of scope

- Auto-retain from `ask_user` answers (host can call `retainContext`)
- Persisting retained store into session JSONL (in-memory for v1)
- Guardian ML / checkpoint files
