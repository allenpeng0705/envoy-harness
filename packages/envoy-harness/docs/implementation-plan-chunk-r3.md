# Chunk R3 — federation + static discovery (Round 2 polish + Round 3)

> **Status:** ✅ DONE (2026-08-22, working tree — pending user commit).
> Round 2 polish (persisted peer endpoints + management surface) and the
> first half of Round 3 (federation into the mesh arbitration store).

## Round 2 polish — static discovery + peer management surface

**Peer package**
- `cluster.ts` — `connectPeerClients(config)` (static discovery: connect
  every configured `{ id, endpoint, model?, capabilities? }` endpoint,
  **fail-open** — bad endpoints are reported, the rest still form the
  cluster) and `createPeerClusterSubmitter(registry)` (a dynamic
  `MeshSubmitter` routing by `preferredPeerId` → capability → any peer —
  the execution pool).

**R3 follow-up (2026-08-22): parallel connect.** `connectPeerClients`
now connects every endpoint **concurrently** (`Promise.all` over the
config), so a dead peer's connect timeout no longer delays the healthy
peers; fail-open and config-ordered results are preserved, and
`connect` is injectable for deterministic tests. The concurrency test
uses a gated fake connect (a sequential implementation would deadlock),
so it runs even where localhost binding is blocked.

**EnvoyMesh**
- `PersistedNodeConfig.envoyHarnessPeers?` — the static peer config.
- `agent-runtime-envoy/peer-pool.ts` — `buildEnvoyHarnessPeerPool(peers)`
  (connect injectable for tests).
- `node-service-impl.ts` — builds the pool once from the config and passes
  `innerSubmitter` to the runtime; **`listEnvoyHarnessPeers()`** (the
  management surface) + `closeEnvoyHarnessPeerPool()` (teardown).

## Round 3 — federation

`agent-runtime-envoy/federate.ts` — `federatePeerScoreboard(store, entries)`:
merge standalone `PeerScoreboard.list()` records (the shared
`VerdictEntry` schema) into the mesh arbitration store via
`recordVerdictEntry` (idempotent). Standalone verification now feeds the
mesh reputation ledger.

**libp2p transport:** remains the v2.2 fabric work (EnvoyMesh). The
`RemoteSubmitterTransport` seam is proven with two implementations; the
libp2p transport plugs into the same seam when the fabric lands.

**v2.2 follow-up (2026-08-22): the libp2p fabric transport is now
implemented** — `task.harness.submit.request/response` protocol payloads
(`@envoymesh/protocol`), the worker-side inbound handler
(`harness-submit-inbound.ts`, adapter-driven execute + signed reply /
wire errors), and `createLibp2pRemoteSubmitterTransport`
(`harness-submit-transport.ts` — expect-reply over the mesh, envelope
signature verification, abort forwarding, self-submit via the local
adapter). Exposed from the node service as
`createLibp2pRemoteSubmitterTransport()`. See
`EnvoyMesh/docs/agent-harness-integration-v2-2-remote-submitter-transport.md`.

## Tests

- Peer package: cluster submitter routing; static discovery over TCP
  (fail-open; self-skips when localhost binding is blocked).
- EnvoyMesh: `envoyHarnessPeers` config round-trip; `buildEnvoyHarnessPeerPool`
  (injected connect, fail-open); `federatePeerScoreboard` (merge +
  idempotence).

## Verification

- EnvoyMesh: `tsc -b` clean; the R3 suites (config round-trip, peer pool,
  federation) green.
- envoy-harness: typecheck clean, build ×6, module-size green; peer suite
  green (cluster routing + static discovery; TCP self-skips in sandboxes
  that refuse localhost binds).
