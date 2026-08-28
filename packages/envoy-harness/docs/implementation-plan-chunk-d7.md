# Chunk D7 — hardening + refinement

> **Status:** ✅ DONE (2026-08-22, working tree — pending user commit).
> Part of the **distributed-collaboration** major feature
> (`docs/distributed-collaboration.md`; `implementation-plan.md`
> §"Distributed collaboration"). **Closes Round 1.**

## Goal

Make the standalone peer protocol production-grade: signed envelopes,
observability events, and documented refinement hooks (discovery +
federation).

## Changes (`packages/envoy-harness-peer/`)

- `envelope.ts` — signed peer envelopes: `PeerSigner`/`PeerVerifier` seams
  (hosts inject Ed25519 — e.g. EnvoyMesh's `signCanonicalPayload`),
  `wrapEnvelope`/`unwrapEnvelope` over the canonical `{ method, payload }`
  JSON. When both sides configure signing, every request travels as
  `{ payload, signature }`.
- `client.ts` — `PeerClientOptions.signer?`; every request enveloped.
- `server.ts` — `createPeerServerHandler({ verifier? })`; requests without
  a valid signature are rejected with a clear error.
- `events.ts` — typed peer observability: `peer.request` /
  `peer.response` (method, ok, durationMs, error). Wired into the client
  (`onEvent`) and server (`onEvent`) — hosts feed envoy's trace/telemetry.

## Refinement hooks (documented, future rounds)

- **Discovery:** static peer config (id/model/capabilities/endpoint) →
  service discovery — the `PeerRegistry` seam is the extension point.
- **Federation:** `PeerScoreboard.list()` already returns the shared
  `VerdictEntry` schema — a host can merge records into EnvoyMesh's
  arbitration store.
- **Transport:** MAP-over-JSON-RPC → libp2p via the same
  `RemoteSubmitterTransport` seam (D6).

## Tests (+4)

- Envelope round-trip; wrong-signature rejection (client → server).
- Canonical payload determinism.
- Observability events emitted on request/response.

## Verification

- Peer suite green — tests cover signed-envelope hardening, observability
  events, and the TCP loopback; full monorepo green; typecheck clean;
  build done; module-size gate green.

## Round 1 complete

D1 adapter-driven worker → D2 peer transport → D3 MAP-over-JSON-RPC server
+ registry → D4 distributed team runner → D5 cross-instance verification +
scoreboard → D6 mesh combination → D7 hardening. A team job spans a mesh
node and a standalone peer cluster, different models, signed envelopes,
verifier discipline, and reputation — over one protocol.
