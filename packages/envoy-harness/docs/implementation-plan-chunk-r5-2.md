# Chunk R5.2 — Peer `exec/*` RPC + live RemoteExecTransport

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 5 ([`implementation-plan-round-5.md`](./implementation-plan-round-5.md)).

## Goal

Wire Package-1 `RemoteExecTransport` / `createPeerExecWorld` over live
peer JSON-RPC (coordinator thinks local; tools hit worker FS/shell).

## Changes

- `peer/exec/read` | `write` | `shell` in peer messages / server / client
- `createPeerRemoteExecTransport({ peerId, client })` in `exec-rpc.ts`
- Optional `execWorld` on `PeerServerOptions`
- Hermetic test using `createLocalExecWorld` on the server

## Accept

- [x] Read / write / shell round-trip over JSON-RPC
- [x] No background peer bash (v1 — same as R4.14b)

## Out of scope

- Background jobs on peer exec-world
- Auto-route `edit` / `git` through exec-world
