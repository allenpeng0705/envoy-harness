# Distributed collaboration — envoy-harness's major feature

> **Status:** DESIGN (2026-08-22) → **Round 4 planned (2026-09-05,
> revised)**. Differentiator = multi-node MAP; **default product** = one
> instance with Codex/dsh-class power. Local sub-agents are mandatory.
> Roadmap: [`implementation-plan.md`](./implementation-plan.md) +
> [`implementation-plan-round-4.md`](./implementation-plan-round-4.md).

## 1. Goal and strategic position

envoy-harness is a **full harness** (local agent loop + sub-agents +
tools + TUI/EHUI) whose **product edge** is distribution — but the
**default deployment is one instance**:

0. **Single-instance (primary audience)** — zero peers, zero mesh. One
   `envoy-harness` process must match Codex / deepseek-harness power for
   everyday coding (sub-agents, modes, async ask, session durability,
   skills, hooks, presets). **Most users will never run multi-nodes.**
1. **Local sub-agents (baseline, required)** — parent `task` tool →
   `MeshSubmitter` → `LocalMeshSubmitter` (new session / specialist on
   this machine), plus capability fan-out and continuable tasks. Codex
   and deepseek also do local multi-agent; we must stay at parity.
2. **Distribution (differentiator)** — the *same* `task` / team /
   submitter seams route work to **other nodes/machines** (standalone
   peers or EnvoyMesh) without a second API.
3. **Collaboration** — agents with **different models** work together
   (route by model, cross-verify across models), with verifier /
   reputation discipline over results.

**One ladder, three rungs** (same `MeshSubmitter` contract):

```
LocalMeshSubmitter  →  PeerMeshSubmitter  →  RemoteMeshSubmitter (libp2p)
   (sub-agent)            (standalone)              (EnvoyMesh)
```

Hosts never teach the model a different tool when work moves off-box —
only the injected submitter changes. With no peers configured, the
ladder stops at rung one — and that rung alone must be excellent.

**Deployment scenarios:**

- **Scenario 0 — Single instance (default):** one process, local
  sub-agents only. Round 4 **D-Refine** targets Codex/dsh parity here.
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

### 1.1 Competitive landscape (refresh 2026-09-05)

Reviewed latest **Codex** (Guardian V2, multi-agent v2, async questions,
exec-server) and **deepseek-harness 0.1.3-alpha.1** (session v2, write
leases, agent teams, workflow, file upload).

| | Codex | deepseek-harness | envoy-harness |
|---|---|---|---|
| Local sub-agents | In-process forks (multi-agent v2) | Provider registry + continuable background | `task` + `LocalMeshSubmitter` + fan-out ✅ |
| Multi-node coding mesh | No (exec-server / cloud tasks ≠ peer mesh) | No (E2B POC; Host↔Client RPC only) | **Peers + EnvoyMesh MAP** ✅ |
| Session durability | Rollout + retained context | Format v2 + write lease + projections | Strong; lease/projection Round 4 |
| Safety UX | Guardian V2, collaboration modes | Permission presets, plan mode | Policy + plan; async-ask Round 4 |

**Porting rule:** borrow *patterns* (hooks merge, retained context,
continuable tasks, parallel DAG), not runtimes (Rust Guardian, full
Cordis rewrite). Ecosystem reuse stays L0/L4 as in
[`reuse-deepseek-tools-skills.md`](./reuse-deepseek-tools-skills.md).

**What we deliberately keep shipping that they also have:** local
sub-agents, skills, MCP, hooks, plan mode, sandbox, ACP/SDK hosts —
and Round 4 **closes remaining single-instance gaps** so a lone
instance is not a “lite” product.
**What only we ship as product:** multi-node MAP + model routing +
cross-instance verify + federatable scoreboards.

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
     └── @envoymesh/envoy-harness-peer     (standalone path: peer server +
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

## 10. Round-by-round refinement (R1–R3 complete)

- **Round 1 (D1–D4):** the primitive — peer transport, server, registry,
  distributed team runner; the feature is demonstrable standalone. ✅
- **Round 2 (D5–D6):** cross-instance verification + EnvoyMesh
  combination (peer cluster as a mesh execution pool). ✅
- **Round 3 (D7):** hardening — signatures, discovery, observability,
  federation seams. ✅
- **Round 4:** see §11 and [`implementation-plan-round-4.md`](./implementation-plan-round-4.md).

Each completed round kept this design doc updated. The differentiator is
the protocol (MAP at two scales) **plus** a real local sub-agent stack —
not a UI or a cloud alone.

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

## 11. Round 4 — Single-instance parity + deepen distribution (2026-09-05)

> **Status:** PLANNED (revised 2026-09-05). Executable chunks:
> [`implementation-plan-round-4.md`](./implementation-plan-round-4.md).
> D1–D7 / R1–R3 remain the foundation. Round 4 has **two equal goals:**
> (0) one instance ≈ Codex/dsh power; (1) multi-node ops production-ready.

### 11.1 Design invariants (Round 4)

1. **Scenario 0 first.** Features that matter for everyday coding must
   work with **zero peers**. Multi-node reuses the same APIs; it does
   not replace local power.
2. **Sub-agents are not optional.** Package 1 keeps `task`,
   `LocalMeshSubmitter`, fan-out, continuable local tasks, and team
   `host: "local"`. Continuable peer tasks share the same lifecycle.
3. **One submitter ladder.** New backends (ACP/Codex/Claude workers)
   register as providers on `MeshSubmitter`, never as a second `task` tool.
4. **Think vs execute may split.** Optional: coordinator keeps the
   model loop local while FS/shell run on a worker peer (Codex
   exec-server *idea*, MAP transport).
5. **Ops completeness over protocol novelty.** Prefer live `team/jobs`,
   parallel DAG, verify budgets, discovery, and scoreboard pull over
   new dialects.

### 11.2 Single-instance stack (Codex/dsh parity — D-Refine)

| Piece | Today | Round 4 target |
|---|---|---|
| Async user input | Sync ask-user | Non-blocking ask-while-busy (R4.1) |
| Compaction | Budget + remote-history | Retained context across compact (R4.2) |
| Session | JSONL + query | Format generation path + write lease (R4.3) |
| Turn outline | Replay-heavy | Projections / turn rail (R4.4) |
| Hooks | Runner exists | Refresh + deny > ask > allow (R4.5a) |
| Permissions | Separate knobs | Presets = sandbox + approval (R4.5b) |
| Collaboration modes | Plan tools | Plan / Default / Review as state + tool policy (R4.6) |
| Skills | Catalog + tools | Fuzzy ranker for `/` (R4.6b) |
| Local sub-agents | `task` + fan-out | Continuable inbox/interrupt/settle (R4.9a) |
| Local teams | Sequential DAG | Parallel ready-set stages (R4.8) |
| Workflow | Capability fan-out | Explicit `parallel` / `pipeline` API (R4.17) |

### 11.3 Multi-node ops stack (differentiator — D-Ops / D-Mesh)

| Piece | Today | Round 4 target |
|---|---|---|
| `team/jobs` ACP | Empty on standalone peer UI | Peer registry fills same schema (R4.7) |
| Peer task lifecycle | Fire-and-forget `peer/submit` | Continuable peer (R4.9b) |
| Verify cost | No session budget | Caps + skip telemetry (R4.10) |
| Scoreboard | `LocalPeerSource` stub | Peer pull (R4.11) |
| Discovery | Static `--peers` + connect | Pluggable mDNS / mesh feed (R4.18) |
| Remote jobs / PTY | `NOOP_REMOTE_*` | Adapter transports (R4.12–13) |
| Job board unify | Mesh-only live data | Chain ↔ peer same ACP type (R4.14) |
| Exec-world | — | Think local / tools on peer (R4.14b) |
| Heterogeneous backends | Local / peer / mesh | Provider registry + ACP/Codex/Claude (R4.15–16) |

### 11.4 Round 4 phases (summary)

| Phase | Theme | Outcome |
|---|---|---|
| **D-Refine** | Single-instance Codex/dsh parity | Ask, modes, session, local continuable, workflow — **ship first** |
| **D-Ops** | Multi-node operational depth | `teamJobs`, peer continuable, verify budgets, discovery, scoreboard |
| **D-Mesh** | EnvoyMesh depth | Remote job/terminal; unify boards; optional exec-world |
| **D-Interop** | Heterogeneous workers | Named backends (ACP/Codex/Claude) |

Full ROI → chunk checklist lives at the top of
`implementation-plan-round-4.md` (every item from the 2026-09-05 review
is mapped; R4.17 workflow + R4.18 discovery were added when the plan
was audited against that list).

### 11.5 Success criteria (Round 4)

**Single-instance (must pass with peers disabled):**

- Async ask-while-busy; collaboration modes change tool policy;
  continuable local sub-agents; session lease + retained context;
  parallel all-`local` team DAG; workflow `parallel`/`pipeline` local.

**Multi-node:**

- Peer `team/jobs` non-empty; continuable peer tasks; verify budgets;
  scoreboard pull; Package 1 stays EnvoyMesh-free; hermetic CI.

### 11.6 Non-goals (Round 4)

- Porting Codex Guardian ML / Windows MXC / voice / Code mode V8.
- Rewriting the harness as all-Cordis; E2B; Typert codegen.
- Building a DHT or replacing EnvoyMesh libp2p.
- EnvoyGo chat attachments (product polish elsewhere).
- Live peer `jobs/*` / `exec/*` RPC and CLI `--discovery` (-> Round 5).

### 11.7 Round 5 (wire live)

See [`implementation-plan-round-5.md`](./implementation-plan-round-5.md).
Theme: peer JSON-RPC for jobs + exec, discovery rail on CLI, adapter
transport factories, remaining U6a TUI polish.

### 11.8 Round 6 (Windows F2 lifecycle)

See [`implementation-plan-round-6.md`](./implementation-plan-round-6.md).
Theme: process-tree kill, sidecar cancel IPC, doctor probe (no FS isolation).

## 12. Round-by-round history (index)

- **Round 1 (D1-D4):** peer transport, server, registry, distributed
  team runner — done
- **Round 2 (D5-D6):** cross-instance verify + EnvoyMesh combination — done
- **Round 3 (D7 + polish):** signatures, discovery, federation seams,
  v2.2 fabric — done
- **Round 4 (D-Refine / D-Ops / D-Mesh / D-Interop):** Scenario 0
  single-instance parity + multi-node ops — IMPLEMENTED (2026-09-06)
- **Round 5 (R5-Wire / R5-Shell):** live jobs/exec RPC, discovery CLI,
  adapter transports, U6a remainder — IMPLEMENTED (2026-09-06)
- **Round 6 (R6-F2):** Windows sandbox lifecycle harden — IMPLEMENTED (2026-09-06)
- **Round 7 (R7-EHUI / R7-Host):** U6b EHUI refine — IMPLEMENTED (2026-09-06)

Each round ships with tests and keeps this design doc updated. The
differentiator remains the protocol (MAP at two scales) plus a real
local sub-agent stack — distribution and collaboration are the product,
sub-agents are the foundation.
