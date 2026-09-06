# Chunk R5.1 — Peer `jobs/*` RPC + live RemoteJobTransport

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 5 ([`implementation-plan-round-5.md`](./implementation-plan-round-5.md)).

## Goal

Wire Package-1 `RemoteJobTransport` over live peer JSON-RPC so
`peer://<id>/jobs/<jobId>` works without hermetic fakes.

## Changes

- `peer/jobs/fetch` | `read` | `kill` | `list` in peer messages / server / client
- `createPeerRemoteJobTransport({ peerId, client })` in `jobs-rpc.ts`
- Optional `jobRegistry` / `jobViewer` on `PeerServerOptions`
- Hermetic in-process pair test

## Accept

- [x] Fetch / read / list / kill over JSON-RPC
- [x] Package 1 stays network-free (transport lives in peer package)

## Out of scope

- Multi-peer routing registry (adapter R5.4)
- Auto-route `job_*` tools by `peer://` id
