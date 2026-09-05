# Chunk R4.6 — Collaboration modes (Plan / Default / Review)

> **Status:** IMPLEMENTED (2026-09-05).
> Part of Round 4 D-Refine ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).
> Design: [`distributed-collaboration.md`](./distributed-collaboration.md) §11.

## Goal

Treat collaboration mode as real session state with tool policy +
prompt guidance — not only plan-document tools / `--plan` CLI.

`ModeKind` is **orthogonal** to `PlanState` (document lifecycle):

| Concern | Owner |
|---|---|
| Plan text / approve / reject | `PlanState` + `/plan` |
| Tool allow/deny + ephemeral prompt | `ModeKind` + `/mode` |

After plan approval, collaboration mode returns to **default** so
mutating tools work while the approved plan fragment still injects.

## Changes

### Core

- `src/plan/mode-kind.ts` — `ModeKind`, `CollaborationModeState`, prompt text
- `src/plan/tool-policy.ts` — mutating denylist; review allowlist; helpers
- `Session` / `PersistedSession` — `get/setCollaborationMode`
- `Agent.setCollaborationMode` — stores/restores sandbox permission mode
- `ToolExecutor` — hard-deny blocked tools before hooks
- `run-loop` — filter model-visible tools each iteration (mid-turn flip OK)
- `assembleTurnContext` — injects COLLABORATION MODE fragment

### Hosts

- REPL `/mode [default|plan|review]`; `/plan enter|approve|exit` sync mode
- `enter_plan_mode` / `exit_plan_mode` tools set mode (approve → default)
- ACP/SDK `session/set_mode`; client `setCollaborationMode`
- TUI `/mode`
- `--plan` one-shot stamps `collaborationMode: plan` on session metadata

## Tests

- `test/plan/collaboration-mode.test.ts` — policy, prompt, Agent restore,
  model tool list + execute block

## Accept

- [x] Mode switch changes available tools + injected prompt
- [x] Plan/review block mutating tools; review uses allowlist
- [x] Hermetic tests (no live LLM)
- [x] Single-instance only (no mesh dependency)

## Out of scope

- EHUI mode picker UI (can call `session/set_mode`)
- R4.6b skill fuzzy ranker
