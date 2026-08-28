# Implementation plan — Phase C (Environment & long-running)

> **Source:** [`gap-closure-plan.md`](./gap-closure-plan.md) items 7, 8, 9.
> **Status:** ✅ shipped locally 2026-08-22 (pending user commit).
> **Conflict boundary:** new modules only (`src/jobs/`, `src/web/`,
> `src/terminal/`, `src/environment/`). Does **not** modify
> `src/plugins/**` (Phase B / MiniMax). `CapabilityContext` optional
> slots for jobs/web/terminals deferred until Phase B settles.

## Review notes (vs deepseek contracts)

| Gap-plan sketch | deepseek reality | envoy choice |
|---|---|---|
| `JobHandle` with `status()` / `wait()` | Producer returns `JobHooks`; registry owns snapshots | Port `JobHooks` + `JobRegistry` |
| Unified `WebProvider` | Separate search + fetch providers on one runtime | Port split providers |
| Simplified PTY create/write/read | Owner-fenced service + backends + send ops | Port service + fake backend; defer `node-pty` |

**Owner fencing:** deepseek uses exact `Agent` instance identity.
envoy-harness uses opaque **owner string** (`session.id`).

## What shipped

| Item | Modules | Tools | Tests |
|---|---|---|---|
| 7 Jobs | `src/jobs/` | `job_start` / `job_status` / `job_output` / `job_wait` / `job_kill` / `job_list` | `test/jobs/registry.test.ts` |
| 8 Web | `src/web/` | `web_search` / `web_fetch` | `test/web/runtime.test.ts` |
| 9 Terminal | `src/terminal/` | `terminal_open` / `terminal_send` / `terminal_read` / `terminal_signal` / `terminal_close` / `terminal_list` | `test/terminal/*.test.ts` |

**CLI:** `wireEnvironmentTools(tools)` in one-shot + REPL (HTTP fetch
provider registered by default; terminal uses fake backend until
`node-pty`).

**Public exports:** additive on `src/index.ts`.

## Deferred follow-ups

- Mesh-remote jobs / terminal / session resume (Phase G adapter)
- Paid search providers beyond Brave (exa/perplexity)
- Full self-evolve feedback injection (consume `toSelfEvolveSignals`)
- OTEL telemetry provider
