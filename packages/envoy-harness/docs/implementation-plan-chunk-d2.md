# Chunk D2 — peer package + transport

> **Status:** ✅ DONE (2026-08-22, working tree — pending user commit).
> Part of the **distributed-collaboration** major feature
> (`docs/distributed-collaboration.md`; `implementation-plan.md`
> §"Distributed collaboration").

## Goal

Standalone peer collaboration (Scenario B, no EnvoyMesh): a new
`@envoymesh/envoy-harness-peer` package with the JSON-RPC transport,
`PeerClient`, and `PeerMeshSubmitter` (a `MeshSubmitter` implementation) —
so the agent loop's `task` tool can submit work to another envoy-harness
instance on the same or a different machine, over the harness's shared
framing.

## Package

`packages/envoy-harness-peer/` — depends only on `@envoymesh/envoy-harness`
(the shared `JsonRpcConnection` framing + `MeshSubmitter` types). Package 1
stays untouched; the peer protocol grows into MAP-over-JSON-RPC in D3.

## Modules

- `messages.ts` — the peer dialect: `peer/ping` (readiness + identity),
  `peer/submit` (`SubagentInput` → `SubagentResult`).
- `client.ts` — `PeerClient`: typed JSON-RPC client over `JsonRpcConnection`
  (request timeout = deadline + 5s; abort via a race on the signal).
- `submitter.ts` — `PeerMeshSubmitter`: implements `MeshSubmitter`
  (`submit` + `listSubagents` with `SubagentRecord`s).
- `server.ts` — `createPeerServerHandler`: the request handler answering
  the dialect (injectable `submit`/`ping`; D3 swaps in the adapter-backed
  execution + `peer/verify` + `peer/manifest`).
- `pair.ts` — `createInProcessPeerPair`: hermetic client/server over
  `PassThrough` streams (ACP test pattern).

## Tests

- In-process pair: ping, submit round-trip (result unchanged), unknown
  method rejection, abort, `PeerMeshSubmitter` contract + spawned records.
- Parity vs `LocalMeshSubmitter`: a peer whose server handler executes via
  the SAME `LocalMeshSubmitter` returns an identical result through the
  transport — no semantic drift.
- Loopback TCP (127.0.0.1, ephemeral port): ping + submit over a real
  socket. Self-skips when the environment refuses localhost binding
  (sandboxed CI; runs for real in normal dev/CI).

## Verification

- `pnpm -r typecheck` clean (6 packages); `pnpm -r test` green
  (peer package tests cover the client dialect, submit round-trip,
  parity, and abort; the loopback TCP test self-skips in sandboxes that
  refuse localhost binds and runs for real elsewhere); module-size gate
  green.

## Next

Chunk D3 — `envoy peer serve` (adapter-backed server: `peer/submit`
executes via `EnvoyHarnessAdapter`, plus `peer/verify` + `peer/manifest`)
and the `PeerRegistry` with model routing.
