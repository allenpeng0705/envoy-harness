# envoy-harness vs EnvoyMesh — the boundary

> **Purpose.** Make the package split explicit so we stop re-asking
> "does this go in envoy-harness?" every time. **This document is the
> source of truth for the boundary; when in doubt, follow it.**

> Companion: [`boundary.zh.md`](./boundary.zh.md) (中文版).

---

## The single rule

**envoy-harness is the local agent runtime. EnvoyMesh is the mesh fabric.**

envoy-harness produces typed, well-documented, locally-runnable surfaces.
EnvoyMesh consumes those surfaces through adapters. The two are connected
by **exactly one** package: `envoy-harness-adapter` (Package 3).

| Layer | What it owns | What it does NOT own |
|-------|--------------|----------------------|
| **envoy-harness (Package 1)** | The local agent loop, type system, built-in capabilities, the `MeshSubmitter` interface, `LocalMeshSubmitter` | Mesh protocols, peer discovery, libp2p, cross-runtime adapters, frontend UIs, mesh-state persistence |
| **envoy-harness-adapter (Package 3)** | The bridge: `EnvoyHarnessAdapter` (mesh-side contract over envoy-harness), `RemoteMeshSubmitter`, `defaultBuildAgent`, `defaultSignResult`, `defaultCrossVerify` | Anything that doesn't talk to BOTH envoy-harness and the mesh |
| **EnvoyMesh (sibling monorepo)** | The mesh fabric: libp2p, peer discovery, capability advertisement, cross-runtime adapters (`OpenClawAdapter`), the chain / verdict ledger, the Tauri UI | The local agent loop, the local type system, the local hook/tool/verifier registries |

---

## What belongs in envoy-harness (Package 1)

- **The agent loop** — `Agent.run`, message handling, tool execution, cost tracking.
- **Type system** — `Message`, `ContentBlock`, `ToolCall`, `ToolResult`,
  `AgentResult`, `SubagentInput`, `SubagentResult`, `MeshSubmitter`.
- **Built-in capabilities** — bash, read_file, hook registry, verifier
  (the 6 rules), `CostTracker`, `LspManager` + 4 LSP tools, `Tracer` +
  `JsonLinesTracer`, `Team`, the `task` tool.
- **Local implementation of sub-agents** — `LocalMeshSubmitter` runs the
  sub-agent in a NEW local session (own id, own AGENTS.md, own hooks,
  own permission). **Even local sub-agents are independent sessions**
  (design invariant #9) so a future `RemoteMeshSubmitter` swaps in
  without code changes.
- **Skill descriptors** — the `ENVOY_HARNESS_SKILLS` catalog (F8.1),
  `SkillDescriptor` type. The local catalog of "what this runtime can do".

---

## What does NOT belong in envoy-harness

- **libp2p / mesh networking** — peer discovery, dial, relay, circuit relay.
- **Cross-peer protocol envelopes** — wire formats for cross-node sub-agent
  submission, capability advertisement, peer messages.
- **Capability advertisement** — the agent-adapter-broadcast machinery
  lives in EnvoyMesh (`agent-adapter-broadcast.ts`).
- **Cross-runtime adapters** — e.g. `OpenClawAdapter`, Pi/Penguin/Codex
  bridges. These translate between EnvoyMesh's wire format and another
  runtime's API. They live in EnvoyMesh because they talk to the mesh.
- **Frontend UIs** — Tauri app, web UI, anything that renders for users.
- **Persistence of mesh state** — peer store, key store, verdict ledger,
  identity. These are mesh-level concerns.

---

## The seam: `envoy-harness-adapter` (Package 3)

**`envoy-harness-adapter` is the ONLY place that knows about both
envoy-harness and the mesh.** It:

- Wraps envoy-harness's `Agent` in an `AgentAdapter` (the mesh-side
  contract: `agent-adapter.ts:AgentAdapter`).
- Provides `defaultBuildAgent({ model, tools, ... })` — the host injects
  the build policy; the adapter creates `Agent` instances on demand.
- Provides `defaultSignResult({ ownerKey })` — the host injects the
  signing key; the adapter signs `SkillResult` (Ed25519) before returning.
- Provides `defaultCrossVerify(otherAdapter)` — cross-agent verification
  using a different adapter.
- Provides `EnvoyHarnessAdapter.execute()` — the mesh-side entry point
  that takes a `SubmitRequest` from the mesh and returns a `SubmitResult`.
- (F10.3) Provides `RemoteMeshSubmitter` — the `MeshSubmitter`
  implementation that submits sub-agents to remote nodes via an injected
  `RemoteSubmitterTransport`.

The dependency direction is strictly:

```
EnvoyMesh ──→ envoy-harness-adapter ──→ envoy-harness
```

envoy-harness has **zero** imports from envoy-harness-adapter or
EnvoyMesh. envoy-harness-adapter has **zero** imports from EnvoyMesh
(only from envoy-harness). EnvoyMesh has imports from both, but
through the public API.

---

## The seam in code

| Concern | Where it lives | What envoy-harness exports | What envoy-harness-adapter provides |
|---------|---------------|----------------------------|--------------------------------------|
| Build an agent | `agent.ts:Agent` + `EnvoyHarnessAdapterInput.buildAgent` | `Agent`, `AgentOptions` | `defaultBuildAgent({ model, tools, cwd, hooks, ... })` |
| Sign a result | `LocalMeshSubmitter` (v0: empty) + `EnvoyHarnessAdapter` (real Ed25519) | `SubagentResult.signature: string` | `defaultSignResult({ ownerKey })` → closure |
| Verify a result | `runLocalVerifier` (6 rules) + `verify()` (concatenates local + cross) | The 6 verifier rules | `EnvoyHarnessAdapter.verify()` |
| Cross-verify | `defaultCrossVerify(otherAdapter)` | The 6 verifier rules | `defaultCrossVerify(otherAdapter)` |
| Submit a sub-agent locally | `LocalMeshSubmitter` | `MeshSubmitter` interface, `LocalMeshSubmitter` | n/a (Package 1 owns this) |
| Submit a sub-agent remotely | `RemoteMeshSubmitter` (F10.3) | `MeshSubmitter` interface | `RemoteMeshSubmitter` (uses injected `RemoteSubmitterTransport`) |
| Federated routing (which peer) | Mesh-side: `agent-adapter-broadcast.ts`, peer discovery, capability matching, load balancing | `SubagentInput.preferredPeerId?: string` + `SubagentInput.routingHint?: RoutingHint` (F10.3.3) — both are HINTS, not routing decisions | n/a (routing lives in EnvoyMesh) |

The **interface** is in envoy-harness. The **default local implementation**
is in envoy-harness. The **mesh-side implementation** is in envoy-harness-adapter.
The **mesh fabric** is in EnvoyMesh.

---

## Federated routing: the seam

**Routing is a mesh concern; envoy-harness exposes the hint, EnvoyMesh decides the target.**

The routing decision — "which peer should this sub-agent run on?" —
is a mesh concern. Peer scoring, capability matching, load balancing,
fallback selection, region biasing — all of it lives in EnvoyMesh
(`agent-adapter-broadcast.ts`, the orchestrator above the transport,
the worker's manifest advertised over libp2p).

envoy-harness's contribution is the **seam**: two hint fields on
`SubagentInput` that the host (or a future `FanOutSpec`, F10.4+) can
set. The mesh-side transport interprets them.

| Field | What it's for | Who sets it |
|-------|---------------|-------------|
| `SubagentInput.preferredPeerId?: string` | A specific peer the model/host wants. v0: hint only; the mesh may override. | The model (via `task` tool's `preferred_peer_id` arg) or the host. |
| `SubagentInput.routingHint?: RoutingHint` (F10.3.3) | Structured advisory: `workerCapabilityTag`, `maxHops?`, `preferredRegions?`. The mesh uses this to bias peer selection. | The host (or a `FanOutSpec`). **NOT the model** — the `task` tool's zod schema does not expose this field. |

**What envoy-harness does NOT do:** peer scoring, load balancing,
capability matching, fallback selection. All of that is a mesh
concern; the mesh-side transport (or the orchestrator above the
transport) makes the call. The F10.3.3 plan called this out
explicitly: "Routing is a mesh concern; envoy-harness exposes the
hint, EnvoyMesh decides the target."

**The transport's contract:** `RemoteSubmitterTransport.send(input,
targetPeerId, signal)` takes the `targetPeerId` as an EXPLICIT
parameter. The submitter (F10.3.2) does NOT decide the target; the
caller (the host, the orchestrator) does. envoy-harness-adapter's
`RemoteMeshSubmitter` accepts a constructor-level `targetPeerId`
for the v0 single-peer case; future `FanOutSpec` can override
per-call.

---

## The 5 deferred items (mapped to the boundary)

These are deferred items from the agent-network improvement work. Each one
is mapped to the layer that owns it.

| # | Item | Layer | Why not envoy-harness |
|---|------|-------|------------------------|
| 1 | "Registrations are effects" | **EnvoyMesh** | envoy-harness is a single runtime. The pattern matters when multiple adapter types are registering in production — that's the mesh world. Could show up as a design principle in envoy-harness's docs (mirror the JSONL append-only pattern at the registry level), but no code work until EnvoyMesh needs it. |
| 2 | HMR / hot reload | **EnvoyMesh** | The re-broadcast machinery lives in EnvoyMesh (`agent-adapter-broadcast.ts`). envoy-harness has no broadcast surface. The "live reload seam that fires a re-broadcast" is a mesh adapter concern. |
| 3 | Agent Skills standard | **EnvoyMesh** | Cross-runtime standard lives at the mesh boundary (the `OpenClawAdapter`). envoy-harness's job is to KEEP producing a stable, well-typed skill surface (`SkillDescriptor`) so the adapter has something good to convert. |
| 4 | Trace observability UI | **Separate frontend project** | Frontend. envoy-harness produces the trace data (F9.4 `JsonLinesTracer` + F8.6+ verdicts); the UI consumes it. The "Second-doctor / verdict write path" gap is now closed — envoy-harness is the data source. |
| 5 | run_subagent clean API | **Already shipped (F10); exposure in EnvoyMesh** | F10.1 + F10.2 are the clean API: `MeshSubmitter.submit`, `LocalMeshSubmitter`, the `task` tool, parallel fan-out, cap. The exposure is `EnvoyHarnessAdapter` calling envoy-harness's API on behalf of remote requests. |

---

## The mental model

- **envoy-harness is what Codex/Claude Code would be if you wrote it
  fresh for a mesh-native world** — the local loop, the local type
  system, the local capabilities, the local sub-agents.
- **envoy-harness-adapter is the wrapper that makes envoy-harness
  pluggable into a P2P mesh** — the bridge that translates between
  the local loop and the mesh-side contract.
- **EnvoyMesh is the mesh itself** — peers, discovery, routing,
  cross-runtime bridges, persistence, UI.

When in doubt: **if it doesn't run on a single machine, it doesn't
belong in envoy-harness. If it doesn't talk to envoy-harness, it
doesn't belong in envoy-harness-adapter. If it doesn't talk to the
mesh, it doesn't belong in EnvoyMesh.**
