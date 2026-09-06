# Round 6 — Windows sandbox lifecycle (F2 harden)

> **Status:** IN PROGRESS (2026-09-06).
> **Design:** [`implementation-plan-chunk-u6-product-shell.md`](./implementation-plan-chunk-u6-product-shell.md) §F2.
> **Master index:** [`implementation-plan.md`](./implementation-plan.md).
> **Prior round:** [`implementation-plan-round-5.md`](./implementation-plan-round-5.md) (IMPLEMENTED).

## Framing

F2a/F2b/F2c scaffolds already exist (`WindowsJobSandboxExecutor`,
`@envoymesh/envoy-sandbox-win`, CLI `--sandbox-executor windows-sandbox`).
Round 6 hardens **abort / cancel** so Windows process trees die reliably
(`taskkill /T`), sidecar cancel is per-request, and doctor probes the
backend. No Rust FS isolation.

**Lead:** F2 lifecycle. **Per-chunk:** `implementation-plan-chunk-r6-*.md`
+ code + tests + commit.

## Phase map

| Chunk | Theme | Priority |
|---|---|---|
| R6.0 | Plan artifacts | P0 |
| R6.1 | `killProcessTree` + wire bash/jobs/exec/hooks | **P0** |
| R6.2 | `spawnCapture` abort hardening | **P0** |
| R6.3 | Sidecar per-request cancel IPC | P1 |
| R6.4 | Doctor probe + F2c docs/tests | P1 |

## Non-goals

- True FS isolation / `windows-sandbox-rs` / `fsIsolation: true`
- Native job-object FFI addon
- `sandbox_backend = "auto"`
- U6b EnvoyGo React panel
- Mesh polish deferred from R5

## Tracking table

| Chunk | Status |
|---|---|
| R6.0 Plan artifacts | **done** |
| R6.1 killProcessTree | **done** |
| R6.2 spawnCapture abort | **done** |
| R6.3 sidecar cancel | **done** |
| R6.4 doctor + docs | pending |

## Success criteria

- Abort/cancel on Windows uses process-tree kill on default bash + sandbox spawn paths
- Sidecar survives single-request abort
- `envoy-harness doctor` probes windows sandbox on win32
- Hermetic CI; Package 1 EnvoyMesh-free; per-chunk commits
