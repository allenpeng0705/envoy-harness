# Distributed collaboration — envoy-harness's major feature

> **Status:** DESIGN (2026-08-22). The strategic differentiator: an agent
> harness whose native execution model is **distribution + collaboration**,
> not local loops. This doc is the design; the chunked roadmap lives in
> `implementation-plan.md` (section "Distributed collaboration"). Refined
> round by round.

## 1. Goal and strategic position

envoy-harness differentiates from other agent harnesses (codex,
deepseek-harness) on two axes:

1. **Distribution** — agents run on different nodes/machines and finish a
   job together, not just sub-agents on one machine.
2. **Collaboration** — agents with **different models** work together
   (route subtasks by model, cross-verify across models), with a
   verifier/reputation discipline over the results.

Two scenarios share this core:

- **Scenario A — EnvoyMesh distribution:** envoy-harness nodes in the
  EnvoyMesh P2P mesh, driven by the chain orchestrator (bids, trust,
  budget, cross-verify, 3-tuple reputation).
- **Scenario B — Standalone peers (no EnvoyMesh):** multiple envoy-harness
  instances on the same or different machines, different models,
  collaborating directly over a lightweight peer protocol.

**The protocol decision:** both scenarios speak the **same message
contract — MAP** (`@envoymesh/protocol` schemas: `ExecuteInput`,
`SignedAgentResult`, `VerifyInput`, `Verdict`, `CapabilityManifest`).
They differ only in the **transport envelope**:

| | Scenario A (EnvoyMesh) | Scenario B (standalone) |
|---|---|---|
| Transport | libp2p + Ed25519 signed envelopes | JSON-RPC framing + shared-token (v1) / signatures (v2) |
| Messages | MAP | MAP (identical schemas) |
| Orchestration | chain orchestrator | distributed team runner (lightweight) |
| Reputation | federated 3-tuple scoreboard | local scoreboards (federatable later) |

One contract, two transports, one worker implementation, one verification
schema. Scenario B is a **subset** of Scenario A minus the mesh fabric —
an upgrade path exists by swapping the transport.

## 2. The seams (already shipped — this is why it's tractable)

| Seam | Where | Role |
|---|---|---|
| `MeshSubmitter` (`submit(input, signal) → SubagentResult`) | Package 1 `src/subagent/` | the submission abstraction; `LocalMeshSubmitter` (same machine), `RemoteMeshSubmitter` (mesh), `PeerMeshSubmitter` (standalone — NEW) |
| `RemoteSubmitterTransport` | Package 3 (`envoy-harness-adapter`) | injected transport owning crypto; mesh (libp2p) and peer (JSON-RPC) are two implementations of the SAME seam |
| `EnvoyHarnessAdapter` (execute/verify/manifest) | Package 3 | the one worker implementation for both scenarios; a peer server is the adapter behind JSON-RPC |
| `ChainSubtask` | EnvoyMesh `@envoymesh/protocol` | the shared unit of work (objective, requiredSkill, costCeiling, deadline, artifacts) |
| `VerdictEntry` | EnvoyMesh `@envoymesh/protocol` | the shared verification record (cross-instance verify + scoreboards) |
| per-call model override (`verifierModel` / `providerHint`) | v1.16 | the mechanism for "different models collaborate" |
| JSON-RPC codec + framing (ACP/SDK) | Package 1 `src/protocol/` | the transport building block for the peer protocol |

## 3. Package boundary

Package 1 keeps its "no EnvoyMesh-internal deps" rule. The standalone peer
protocol depends on `@envoymesh/protocol` (Package 2, in EnvoyMesh), so it
lives in a **new peer package**, mirroring the adapter:

```
EnvoyMesh ── @envoymesh/protocol (MAP schemas — the shared contract)
     │
     ├── @envoymesh/envoy-harness-adapter  (mesh path: adapter + RemoteMeshSubmitter)
     └── @envoymesh/envoy-harness-peer     (NEW: standalone path: peer server +
                                           PeerMeshSubmitter + PeerRegistry)
envoy-harness (Package 1) stays clean; the peer package depends on it.
```

## 4. The peer protocol (Scenario B) — MAP-over-JSON-RPC

**Dialect:** the MAP message set carried over JSON-RPC 2.0 (Content-Length
framing — reuse `src/protocol/framing.ts`):

| Method | Payload | Response |
|---|---|---|
| `peer/ping` | `{ peerId, model, capabilities }` | `{ ok: true }` |
| `peer/submit` | `ExecuteInput`-shaped task | `SignedAgentResult` |
| `peer/verify` | `VerifyInput`-shaped (result + objective) | `Verdict[]` |
| `peer/manifest` | — | `CapabilityManifest` |

**Identity/auth (v1):** shared-secret token in the JSON-RPC header.
**v2:** Ed25519-signed envelopes (reuse the canonical-payload signer
seam), so standalone peers become wire-compatible with the mesh envelope
shape.

**Model routing:** each peer announces `{ model, capabilities }`; the
orchestrator's `PeerRegistry` routes a subtask to the peer with the
matching model (the standalone analog of the mesh's capability-manifest
routing).

## 5. How the two scenarios combine

**Pattern A — standalone peers as a mesh node's execution pool.** A mesh
node's chain worker routes subtasks through `MeshSubmitter`; instead of
`LocalMeshSubmitter`, a `PeerMeshSubmitter` fans work out to a cluster of
envoy-harness instances (different machines, different models). The mesh
chain orchestrates; the peer cluster executes; the instances never need to
be mesh nodes.

**Pattern B — same job contract, two orchestrators.** A team job in the
shared `ChainSubtask` shape runs either through the mesh chain
(bids/trust/reputation) or through the standalone peer runner
(lightweight, model-routed). Because both use the same worker + same
result/verdict schemas, a job that outgrows the peer cluster promotes into
the mesh without reshaping the work.

**The unifier:** one `MeshSubmitter` abstraction + one
`RemoteSubmitterTransport` seam + one `EnvoyHarnessAdapter` worker + one
`VerdictEntry` schema. Local, peer, and mesh are three submission surfaces,
not three systems.

## 6. Phases and chunks

> Per-chunk discipline (repo convention): each chunk = one sub-plan doc
> (`implementation-plan-chunk-*.md`) + code + tests + a self-review commit.

### D1 — Adapter-driven chain worker (PREREQUISITE)
Finish the documented Step 2: `createEnvoyHarnessChainSubtaskExecutor`
drives the `EnvoyHarnessAdapter.execute` path (structured result + named
artifacts) instead of the legacy text-ask wrapper. One upgrade, two
scenarios: it unblocks both the mesh team-job path and the peer server.
**✅ DONE (2026-08-22)** — lazy `adapter` getter in
`createMapChainSubtaskExecutor`, the envoy executor delegates to it, the
host passes `deps.getEnvoyHarnessAdapter?.()`; 449 EnvoyMesh hermetic tests
green (chunk doc: `EnvoyMesh/docs/implementation-plan-chunk-d1.md`).

### D2 — Peer package scaffold + transport
- `@envoymesh/envoy-harness-peer` (new package; depends on
  `@envoymesh/protocol` + `@envoymesh/envoy-harness`).
- JSON-RPC transport (reuse framing) + `PeerClient` + `PeerMeshSubmitter`
  (a `MeshSubmitter` implementation).
- Hermetic tests: in-process transport pair (ACP-test pattern) + parity vs
  `LocalMeshSubmitter`; then loopback TCP.
**✅ DONE (2026-08-22)** — `packages/envoy-harness-peer/` ships
`PeerClient`, `PeerMeshSubmitter`, `createPeerServerHandler`, the
in-process pair, parity-vs-local and loopback-TCP tests (self-skipping when
the environment can't bind localhost). Note: D2 depends only on
`@envoymesh/envoy-harness` (shared framing); the `@envoymesh/protocol`
MAP-shaped messages arrive with the D3 server.

### D3 — Peer server + registry + model routing
- `envoy peer serve` mode: `EnvoyHarnessAdapter` behind a JSON-RPC
  endpoint (`peer/submit`, `peer/verify`, `peer/manifest`).
- `PeerRegistry`: announce `{ id, model, capabilities }`; route by model.
- Tests: two in-process peers with different models; routing + verify
  round-trips.
**✅ DONE (2026-08-22)** — the peer protocol is MAP-over-JSON-RPC for
real: `createPeerServerHandler({ adapter, identity })` answers
execute/verify/manifest/ping; `PeerRegistry` routes by explicit id,
capability, or `pickByModel` (no fallback); `PeerMeshSubmitter` maps
`SubagentInput → ExecuteInput → SignedAgentResult → SubagentResult`. The
v1.16 `verifierModel` travels over the wire (tested). The **`envoy-peer
serve` CLI** (`bin/envoy-peer.ts` in `@envoymesh/envoy-harness-peer`)
starts the server over TCP with `--adapter <module>` (ESM default export
or factory) or the built-in demo adapter; optional
`--verify-after-execute` runs `adapter.verify` per submit and returns the
combined verdict in the response.

### D4 — Distributed team runner
- Extend `TeamConfig` agents with `host: "local" | "peer://<id>"`.
- The runner dispatches local vs peer using the shared subtask shape.
- Tests: mixed local+peer team over an in-process transport.
**✅ DONE (2026-08-22)** — `AgentSpec.host` (TOML-parsed),
`TeamOptions.peerExecutor` seam (Package 1 clean), and the peer package's
`createPeerTeamExecutor` (registry + PeerMeshSubmitter). Mixed local+peer
teams run in topological order; peer agents never touch the local model.

### D5 — Cross-instance verification + scoreboard
- Standalone cross-instance verify via `peer/verify` (different model),
  reusing the verifier + per-call model hint.
- Local scoreboards write `VerdictEntry` (federatable into the mesh later).
- Tests: orchestrator verifies a peer's result with a different model.
**✅ DONE (2026-08-22)** — `createCrossInstanceVerifier` routes
`peer/verify` by model; `PeerScoreboard` records/aggregates `VerdictEntry`;
`createVerifiedScoreKeeper` combines + records (mesh rule, `verifierModel`,
`issuedBy`). Records are the shared mesh schema — federatable later.

### D6 — EnvoyMesh combination
- `RemoteSubmitterTransport` peer implementation: a mesh node's
  `RemoteMeshSubmitter` can target the standalone peer protocol.
- EnvoyMesh v2.2 libp2p transport (the fabric) + peer-cluster-as-pool
  wiring.
- Tests: mesh-shaped chain job fanning out to an in-process peer cluster.
**✅ DONE (2026-08-22)** — `createPeerRemoteSubmitterTransport` in the
adapter routes a mesh node's `RemoteMeshSubmitter` to a peer cluster
(Pattern A). The v2.2 libp2p fabric plugs into the same seam. (The
mesh-shaped chain-job fan-out test lands with D1's chain worker in an
EnvoyMesh integration chunk.)

### D7 — Hardening + refinement
- Security: shared-token → Ed25519-signed envelopes.
- Observability: peer events in the trace/telemetry sinks.
- Round-by-round refinement hooks: static peer config → discovery;
  JSON-RPC → libp2p; local scoreboards → federation.
**✅ DONE (2026-08-22) — Round 1 complete.** Signed envelopes
(`PeerSigner`/`PeerVerifier` seams, canonical-payload signature), peer
observability events (client + server sinks), and the refinement hooks
documented (discovery via `PeerRegistry`, federation via
`PeerScoreboard.list()` → the mesh arbitration store, libp2p via the
`RemoteSubmitterTransport` seam).

## 7. Test strategy

- **Hermetic:** in-process transport pairs, fake peers, loopback TCP;
  no network, no real LLM (scripted models).
- **Parity:** `PeerMeshSubmitter` vs `LocalMeshSubmitter` (same lifecycle).
- **Cross-instance:** orchestrator + two different-model peers over the
  in-process transport; verifier round-trips.
- **Combination:** a chain-shaped job (D1 executor) fanning out to a peer
  cluster (D6) in one hermetic test.

## 8. Success criteria (v1)

- A standalone peer cluster (different machines, different models)
  completes a multi-agent job with cross-instance verification — no
  EnvoyMesh.
- The same job shape runs through the EnvoyMesh chain (worker + verifier).
- A mesh node can delegate subtasks to a peer cluster via the
  `RemoteSubmitterTransport` seam.
- Package 1 stays EnvoyMesh-free; the peer package owns the protocol.
- All hermetic; module-size + typecheck gates green; both repos green.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Building a second EnvoyMesh | The peer layer is deliberately small (submit/verify/manifest + routing); no DHT/reputation federation in v1 |
| Protocol drift between peer and mesh | Both use `@envoymesh/protocol` schemas — one source of truth |
| Distributed-systems complexity (deadlines, retries, idempotency) | `correlationId` reuse; bounded retries; per-chunk tests |
| Security (peer auth) | v1 shared-token; v2 signed envelopes via the existing signer seam |
| D1 regression risk | The chain worker change is additive (structured result path); parity tests vs the legacy ask path |

## 10a. Known limitations (2026-08-22 review)

- **Model-side peer discoverability.** **RESOLVED (2026-08-23):** the
  peer package ships `createPeersTool(registry)` — a model-facing
  `peers` tool that lists `{ id, model, capabilities }` and tells the
  model to route with `task.preferred_peer_id`. Hosts wire it when they
  configure a peer cluster (EnvoyMesh adds it to `bClassTools` when
  `envoyHarnessPeers` is set; the adapter exposes it under the
  `peer-cluster` skill). Package 1 stays clean — the tool lives in the
  peer package, and the `task` schema's `preferred_peer_id` hint is
  already threaded to the submitter.
- **Verdict honesty.** `PeerMeshSubmitter.submit()` synthesizes a v1
  placeholder verdict unless the server runs `adapter.verify` after
  execute (`--verify-after-execute` / `verifyAfterExecute`). Hosts that
  route on `result.verdict.kind` should enable that option or use the D5
  cross-instance verifier.

## 10b. Host guide — verdict routing (2026-08-23 review)

For hosts that route on `result.verdict.kind`, the peer cluster offers
two honest-verdict paths, each with a cost tradeoff:

- **`--verify-after-execute`** (server-side): every `peer/submit` runs
  `adapter.verify` after execute and returns the combined verdict. Use
  it when the adapter's verifier is cheap (rule-based). With an LLM
  verifier this is effectively **2× model cost per submit** — there is
  no rate/cost budget yet (a `max verifications per session` / "skip
  verify when remaining budget < X" knob is a follow-up). Prefer the
  default **off** on trusted peers, and treat the v1 placeholder as
  "ran to completion" rather than "correct".
- **`peer/verify` after `peer/submit`** (D5 cross-instance): the
  orchestrator asks a peer with a DIFFERENT model to verify the result.
  More latency and an extra round trip, but it is the "second opinion"
  path and the verdicts feed the `PeerScoreboard` (federatable).

Routing guidance: use the placeholder only for smoke/demo; use
`verifyAfterExecute` for rule-based verifiers; use D5 for
cost-sensitive or high-stakes routing.

## 10. Round-by-round refinement

- **Round 1 (D1–D4):** the primitive — peer transport, server, registry,
  distributed team runner; the feature is demonstrable standalone.
- **Round 2 (D5–D6):** cross-instance verification + EnvoyMesh
  combination (peer cluster as a mesh execution pool).
- **Round 3 (D7):** hardening — signatures, discovery, observability,
  federation seams.

Each round ships with tests and keeps the design doc updated. The
differentiator is the protocol (MAP at two scales), not a UI or a cloud —
distribution and collaboration are the product.

**Round 2 status (2026-08-22): ✅ DONE** — `connectPeerClient` (TCP
transport) + the runtime's injectable `innerSubmitter` (execution pool). An
EnvoyMesh integration test proves the mesh-shaped fan-out: a chain worker's
`task` tool submits to a peer cluster and the result flows back through the
chain worker. Remaining Round-2 polish: persisted node-config peer
endpoints (static discovery) + a peer management surface.

**Round 2 polish + Round 3 (2026-08-22): ✅ DONE** — `connectPeerClients`
(static discovery, fail-open) + `createPeerClusterSubmitter` (dynamic
pool), `PersistedNodeConfig.envoyHarnessPeers`, the node's
`listEnvoyHarnessPeers()` management surface, and
`federatePeerScoreboard` (standalone verdicts → the mesh arbitration
store, idempotent).

**v2.2 libp2p fabric (2026-08-22): ✅ DONE** — the mesh-side
`RemoteSubmitterTransport` is implemented: `task.harness.submit.request/
response` intents (protocol schemas + role policy), the worker-side
inbound handler (`NodeServiceImpl.handleInboundHarnessSubmitRequest` →
`EnvoyHarnessAdapter.execute`), and `createLibp2pRemoteSubmitterTransport`
(expect-reply over the mesh, envelope verification, abort forwarding,
self-submit via the local adapter). A mesh node's `RemoteMeshSubmitter`
can now target ANOTHER mesh node's envoy-harness worker directly
(Pattern B) — the seam's second implementation alongside the peer
JSON-RPC transport (Pattern A).
