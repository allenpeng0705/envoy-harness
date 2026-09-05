# Chunk R4.17 — Workflow-style fan-out API

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 4 D-Refine + D-Ops ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).

## Goal

Explicit `parallel(tasks)` / `pipeline(steps)` over `MeshSubmitter`
(dsh-style orchestration beyond opaque F10.4 fan-out / R4.8 TOML teams).

## Changes

- `src/subagent/workflow.ts` — `parallel`, `pipeline`
- Re-exports from `subagent/index` + package root
- Hermetic tests with a scripted `MeshSubmitter`

### Semantics

| API | Behavior |
|---|---|
| `parallel` | `Promise.all` over tasks; aggregate via `aggregateFanOutResults`; optional `maxSubagents` refuse-all |
| `pipeline` | Sequential submits; prior text appended as context; stop on `failed` |
| Peer routing | `SubagentInput.preferredPeerId` forwarded (e.g. `peer://…`) |

## Tests

- `test/subagent-workflow.test.ts` — concurrent parallel, maxSubagents,
  preferredPeerId, pipeline context, early fail

## Accept

- [x] Local parallel + pipeline hermetic tests
- [x] Same API accepts peer ids via `preferredPeerId`

## Out of scope

- Model-facing `parallel` / `pipeline` tools (host API is enough for v1)
- Peer-package CI (Package 1 stays peer-free)
