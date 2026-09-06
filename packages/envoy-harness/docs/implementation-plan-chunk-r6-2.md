# Implementation plan chunk — R6.2 spawnCapture abort

> Part of Round 6 ([`implementation-plan-round-6.md`](./implementation-plan-round-6.md)).
> **Status:** done (2026-09-06).

## Delivered

- `spawnCapture` registers an abort listener that calls `killProcessTree`
  in addition to Node's spawn `signal` (Windows tree kill).
- Hermetic `test/sandbox/spawn-capture-abort.test.ts` — long sleep + abort
  settles in &lt; 5s.

## Accept

F2a `WindowsJobSandboxExecutor` inherits tree kill on abort via spawnCapture.
