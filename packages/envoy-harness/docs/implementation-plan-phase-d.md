# Implementation plan — Phase D (Data & observability)

> **Source:** [`gap-closure-plan.md`](./gap-closure-plan.md) items 14a, 14b (P1), 16, 17.
> **Status:** ✅ shipped locally 2026-08-22 (pending user commit).
> **Also closes Phase C deferred:** item 13 wire-up, Brave search, `node-pty`,
> `bash --job` sugar, `CapabilityContext` environment slots.

## What shipped

| Item | Modules | Notes |
|---|---|---|
| 13 Credentials (wire) | `environment/wire.ts` | Cascade env → `~/.config/.../credentials.json` → ask; returned on `EnvironmentCapabilities` |
| 8 Brave search | `web/search-brave.ts` | `available()` cheap; hermetic mocked-fetch tests |
| 9 node-pty | `terminal/pty-backend.ts` | optionalDependency; fake fallback |
| 7 bash --job | `tools/builtin/bash.ts` | `makeBashTool({ jobs })` + `background?: boolean` |
| CapabilityContext | `plugins/types.ts` | optional `jobs` / `web` / `terminals` / `credentials` |
| 14a Session query | `session/indexer.ts`, `session/query.ts` | `session_query` tool; workspace-dir auth |
| 14b Provenance | `session.ts`, `persisted-session.ts`, argv | `provenance` + `checkpoint()`; `--resume-remote` stub |
| 16 Feedback | `src/feedback/` | append-only log + sidecar CRUD + `toSelfEvolveSignals` guard |
| 17 Observability | `trace/telemetry.ts`, `trace/invariants.ts` | sinks + redaction invariant |

## Tests

Run:

```sh
pnpm exec vitest run test/credentials test/web test/terminal test/jobs test/session test/feedback test/trace
```
