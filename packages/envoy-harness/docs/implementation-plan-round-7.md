# Round 7 — U6b EHUI refine

> **Status:** IN PROGRESS (2026-09-06).
> **Design:** [`implementation-plan-chunk-u6-product-shell.md`](./implementation-plan-chunk-u6-product-shell.md) §U6b,
> [`ehui-panel-spec.md`](./ehui-panel-spec.md).
> **Master index:** [`implementation-plan.md`](./implementation-plan.md).
> **Prior:** [`implementation-plan-round-6.md`](./implementation-plan-round-6.md) (IMPLEMENTED).

## Framing

Windows Job-object FFI / FS isolation stay **skipped**. Round 7 refines the
IDE EHUI shell: TUI-parity panel bodies in `@envoymesh/envoy-harness-ehui`,
then EnvoyMesh chat-scoped invoke + side dock.

**Lead:** rich shared renderers first (this monorepo); host layout in EnvoyMesh.
**Per-chunk:** `implementation-plan-chunk-r7-*.md` + code + tests + commit.
EnvoyMesh chunks commit in that repo with matching messages.

## Phase map

| Chunk | Theme | Repo |
|---|---|---|
| R7.0 | Plan artifacts | envoy-harness |
| R7.1 | Plan / Memory / Diff renderers | envoy-harness-ehui |
| R7.2 | Mesh / cluster / list formatters | envoy-harness-ehui |
| R7.3 | chatId-scoped EHUI invoke | EnvoyMesh |
| R7.4 | EhuiShell side dock | EnvoyMesh |
| R7.5 | Resume picker + tests | both |

## Non-goals

- Rust / Windows FS isolation / Job-object FFI
- Embedding full TUI; Ink/Blessed
- Chat transcript inside EHUI

## Tracking table

| Chunk | Status |
|---|---|
| R7.0 Plan artifacts | **done** |
| R7.1 rich panels | **done** |
| R7.2 mesh formatters | **done** |
| R7.3 chat scope | **done** (EnvoyMesh) |
| R7.4 side dock | pending |
| R7.5 resume + tests | pending |

## Success criteria

- Plan / Memory / Diff readable (headers + colored diff classes)
- Mesh vs cluster distinct; team/scoreboard usable
- EHUI follows open chat cwd; desktop side dock beside Pi
- Hermetic ehui tests; Package 1 EnvoyMesh-free
