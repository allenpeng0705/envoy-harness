# Chunk R4.12 — Mesh-remote JobTransport

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 4 D-Mesh ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).

## Goal

Fill `jobs/remote.ts` beyond `NOOP`: a real transport contract plus a
hermetic fake that adapters can mirror when EnvoyMesh / peer RPC lands.

## Changes

- `RemoteJobTransport` — `fetchJob` / `readOutput` / `kill` / `listJobs`
- Refs: `peer://<peerId>/jobs/<jobId>` (`formatRemoteJobRef` /
  `parseRemoteJobRef` / `isRemoteJobRef`)
- `FakeRemoteJobTransport` — attach local `JobRegistry` per peer
  (optional `viewer` for owner fencing)
- `NOOP_REMOTE_JOB_TRANSPORT` retained (`NOT_CONFIGURED`)
- Exports from `jobs/index` + package root
- `test/jobs/remote.test.ts`

## Accept

- [x] Hermetic fake fetch / read / list / kill
- [x] Invalid refs and abort → typed `RemoteJobError`
- [x] Package 1 stays peer-network-free

## Out of scope

- Live peer/JSON-RPC `jobs/*` methods (adapter / R4.14 board unify)
- Wiring `job_*` tools to auto-route `peer://` ids (follow-up)
