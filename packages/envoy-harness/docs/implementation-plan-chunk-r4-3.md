# Chunk R4.3 — Session format hardening (v2 + write lease)

> **Status:** IMPLEMENTED (2026-09-05).
> Part of Round 4 D-Refine ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).

## Goal

Single-writer when multiple hosts touch the same JSONL, plus a
documented adjacent-successor migration path (no silent rewrite on open).

## Changes

### Write lease

- `src/session/write-lease.ts` — sidecar `<file>.lock` via exclusive
  create (`wx`); stale PID cleanup; same-process refcount;
  `SessionFileBusyError` on contention
- `PersistedSession.create` / `open` acquire lease; `close()` releases
- `PersistedSession.openReadOnly` — no lease (inspectors / migrate)

### Format v2

- `src/session/format.ts` — `PERSISTED_SESSION_FORMAT_VERSION = 2`,
  `generation` on header; readers accept v1 + v2
- Writers emit v2 + `generation: 1`
- `open` never migrates

### Migration

- `src/session/migrate.ts` — `migrateSessionFile` v1→v2 only
  (backup `.v1.bak` by default); refuses skip-level / already-v2

## Tests

- `test/persisted-session.test.ts` — create writes v2
- `test/session/r4-3-lease-migrate.test.ts` — contention, read-only
  under lease, migrate preserves messages, open does not rewrite

## Accept

- [x] Contended open fails clearly (`SessionFileBusyError`)
- [x] Fixture migration v1→v2 hermetic
- [x] Open never silently upgrades format

## Out of scope

- Native `flock` / `LockFileEx` (sidecar lock is zero-dep)
- CLI `envoy session migrate` command
- ACP auto-close wiring (callers should `close()` after `flush()`)
