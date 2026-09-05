# Chunk R4.5a — Hook refresh + merge precedence

> **Status:** IMPLEMENTED (2026-09-05).
> Part of Round 4 D-Refine ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).

## Goal

Conflicting PreToolUse hooks resolve **deny > ask > allow** (dsh),
and refreshing hooks mid-session does not drop an in-flight turn
(Codex-style plugin refresh).

## Changes

### Core

- `src/hooks/merge.ts` — `mergeHookDecisions` (deny > ask > allow,
  then add-context / modify)
- `src/hooks/registry.ts` — all matched handlers run; merge via
  `mergeHookDecisions`; `fire()` snapshots handler/middleware lists;
  `refresh(reconfigure)` clears + re-registers
- `Agent.refreshHooks(reconfigure)` — thin facade

### Semantics

| Axis | Rule |
|---|---|
| Permission | first `block` > last `ask` > `continue` |
| Context | concatenated when no deny/ask |
| Modify | last wins (Pre/PostToolUse) when no deny/ask |
| Middleware | still short-circuits on `block` (before handlers) |
| Refresh | in-flight `fire` keeps snapshot; next `fire` sees new set |

## Tests

- `test/hooks/merge-precedence.test.ts` — order matrix + mid-fire refresh
- `test/hooks-registry.test.ts` — deny no longer short-circuits later handlers

## Accept

- [x] Conflicting hooks resolve deny > ask > allow
- [x] Refresh does not drop in-flight turn

## Out of scope

- File-watch auto-reload / REPL `/reload` command (host can call `refreshHooks`)
- Config layer hooks array concat vs replace
