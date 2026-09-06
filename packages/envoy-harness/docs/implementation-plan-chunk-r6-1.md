# Implementation plan chunk — R6.1 killProcessTree

> Part of Round 6 ([`implementation-plan-round-6.md`](./implementation-plan-round-6.md)).
> **Status:** done (2026-09-06).

## Delivered

- `src/process/kill-tree.ts` — re-exports `@envoymesh/envoy-process`
  (`taskkill /PID /T /F` on win32; else `SIGKILL`)
- Wired into bash default path, `process-provider` cancel, local exec-world shell, hook runner timeout
- Hermetic tests in `packages/envoy-process/test/kill-tree.test.ts` (real child on win32)

## Accept

Abort/timeout hard-kill paths use process-tree kill on Windows; Unix still SIGKILLs the pid.
