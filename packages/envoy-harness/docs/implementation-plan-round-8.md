# Round 8 — Standalone CLI power + WebUI MVP

> **Status:** IMPLEMENTED (2026-09-06).
> **Master index:** [`implementation-plan.md`](./implementation-plan.md).
> **Prior:** [`implementation-plan-round-7.md`](./implementation-plan-round-7.md) (IMPLEMENTED).
> **UI vision:** [`envoy-harness-ui.md`](./envoy-harness-ui.md).

## Framing

Most usage is **standalone** (not EnvoyMesh). Round 8 hardens the CLI
(default `LocalMeshSubmitter`, long-run defaults, peers parity) and adds
`@envoymesh/envoy-harness-web` — a browser MVP over ACP.

**Locked:** CLI harden + WebUI MVP in one round; new web package in this
monorepo (no EnvoyMesh required).

**Per-chunk:** `implementation-plan-chunk-r8-*.md` + code + tests + commit.

## Phase map

| Chunk | Theme |
|---|---|
| R8.0 | Plan artifacts |
| R8.1 | Default LocalMeshSubmitter + `--no-subagents` |
| R8.2 | Long-run defaults, persist UX, peers parity |
| R8.3 | `envoy-harness-web` scaffold (Vite + ACP WS bridge) |
| R8.4 | WebUI chat / permissions / model settings / resume |
| R8.5 | EHUI side dock + docs close-out |

## Non-goals

- EnvoyMesh Social / Tauri parity
- Full dsh dashboard (billing, org admin, marketplace)
- Changing `Agent` constructor defaults (submitter stays host-injected)

## Tracking table

| Chunk | Status |
|---|---|
| R8.0 Plan artifacts | **done** |
| R8.1 CLI sub-agents | **done** |
| R8.2 long-run + peers | **done** |
| R8.3 web scaffold | **done** |
| R8.4 web MVP | **done** |
| R8.5 EHUI + close-out | **done** |

## Success criteria

- Sub-agents on by default in REPL / one-shot / ACP; `--no-subagents` opt-out
- Parallel `task` works without EnvoyMesh
- REPL long-run friendly (persist + higher turn budget)
- Peers flag on REPL/one-shot
- WebUI: chat + permissions + model settings + resume + EHUI dock
- Package 1 EnvoyMesh-free; hermetic tests; per-chunk commits
