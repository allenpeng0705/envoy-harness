# Implementation plan — Phase F (item 4)

> Status: **DONE** locally 2026-08-22 (pending user commit).

## Scope

OS-level sandbox backends on the existing `SandboxExecutor` seam:

| Chunk | Deliverable |
|-------|-------------|
| C1 | `LandlockSandboxExecutor` + policy→grants + hermetic tests |
| C2 | `SeatbeltSandboxExecutor` + profile generation + resolve wiring |

## Layout

```
src/sandbox/
  types.ts              # SandboxExecutor + NoopSandboxExecutor (pre-existing)
  policy.ts             # SandboxPolicy → landlock grants / seatbelt profile
  resolve.ts            # platform + backend selection
  backends/landlock.ts  # @deepseek-ai/node-addon-landlock-run (optionalDep)
  backends/seatbelt.ts  # macOS sandbox-exec
```

Agent resolves an executor into `ToolContext.sandboxExecutor`; bash uses it
after the 6 validators.

## Verification

- `vitest run test/sandbox-backends.test.ts test/sandbox.test.ts` — 14 tests
- `tsc --noEmit` clean

## Out of scope (optional)

- Windows job-object backend
- Linux CI live landlock smoke (marked live; needs landlock-enabled kernel)
- Network confinement beyond seatbelt deny + bash validators
