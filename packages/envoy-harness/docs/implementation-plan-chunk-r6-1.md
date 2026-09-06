# Implementation plan chunk — R6.1 killProcessTree

> Part of Round 6 ([`implementation-plan-round-6.md`](./implementation-plan-round-6.md)).
> **Status:** done (2026-09-06).

## Delivered

- `src/process/kill-tree.ts` — win32 `taskkill /PID /T /F`; else `SIGKILL`
- Wired into bash default path, `process-provider` cancel, local exec-world shell, hook runner timeout
- Hermetic tests in `test/kill-tree.test.ts`

## Accept

Abort/timeout hard-kill paths use process-tree kill on Windows; Unix still SIGKILLs the pid.
