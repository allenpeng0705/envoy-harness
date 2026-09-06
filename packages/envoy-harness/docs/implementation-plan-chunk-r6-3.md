# Implementation plan chunk — R6.3 sidecar cancel IPC

> Part of Round 6 ([`implementation-plan-round-6.md`](./implementation-plan-round-6.md)).
> **Status:** done (2026-09-06).

## Delivered

- Protocol `cancel` method with `params.id` targeting an in-flight execute
- Sidecar `bin.ts` handles requests concurrently; per-execute `AbortController`
- `execute.ts` tree-kills on abort signal
- Harness `WindowsSidecarSandboxExecutor` sends cancel IPC instead of killing the sidecar
- Hermetic fake-sidecar test + execute abort test

## Accept

Abort one request; second request succeeds on the same sidecar process.

## Review follow-up

- Fake sidecar fixture is `fake-sandbox-sidecar.js` only (`.mjs` duplicate removed).
- `killProcessTree` lives in `@envoymesh/envoy-process` (shared by harness + sandbox-win).
- `cancelSoftFailMs` configures the sidecar cancel soft-fail timer.
- `envoy-process` tests exercise a real child on win32 (`taskkill` on windows-latest).
