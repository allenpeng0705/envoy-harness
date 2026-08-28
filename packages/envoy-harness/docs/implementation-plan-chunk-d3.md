# Chunk D3 — peer server + registry + model routing

> **Status:** ✅ DONE (2026-08-22, working tree — pending user commit).
> Part of the **distributed-collaboration** major feature
> (`docs/distributed-collaboration.md`; `implementation-plan.md`
> §"Distributed collaboration").

## Goal

Make the peer protocol **MAP-over-JSON-RPC for real**: the peer server is
backed by an `AgentAdapter` (for envoy-harness: the live
`EnvoyHarnessAdapter`), and a `PeerRegistry` routes work by model and
capability — the "different models collaborate" mechanism.

## Changes (`packages/envoy-harness-peer/`)

- `package.json` — new deps: `@envoymesh/agent-adapter` +
  `@envoymesh/protocol` (link: to EnvoyMesh, same pattern as the adapter).
- `messages.ts` — the full dialect: `peer/ping`, `peer/submit`
  (`ExecuteInput` → `SignedAgentResult`), `peer/verify` (`VerifyInput` →
  `Verdict[]`), `peer/manifest` (`BuildManifestInput` → `CapabilityManifest`).
- `server.ts` — `createPeerServerHandler({ adapter, identity })`: the
  MAP-backed handler (execute/verify/manifest/ping with model
  advertisement). The D2 SubagentInput-injectable handler is gone.
- `mapping.ts` — `subagentInputToExecuteInput` +
  `signedResultToSubagentResult` (wire text blocks → local content; other
  kinds summarized; status/verdict synthesized v1).
- `client.ts` — `PeerClient.execute/verify/manifest` (MAP) + `submit`
  convenience (MeshSubmitter-shaped).
- `submitter.ts` — `PeerMeshSubmitter.submit` now maps through the MAP
  execute (`SubagentInput → ExecuteInput → SignedAgentResult →
  SubagentResult`).
- `registry.ts` — `PeerRegistry`: register/list/route (explicit peer id →
  capability → first) + `pickByModel` (explicit model routing, no
  fallback).

## Tests

- `adapter-server.test.ts` — the MAP-backed server routes
  execute/verify/manifest/ping to the adapter; the v1.16 per-call
  `verifierModel` travels over the wire.
- `registry.test.ts` — model routing, capability routing, explicit peer id,
  duplicate rejection, disposers.
- Updated D2 tests (peer-client, parity, TCP) to the MAP-shaped server;
  parity is shape-level (status/runtime/content).

## Verification

- `tsc` clean; peer suite green — tests cover the MAP-backed server
  dialect (execute/verify/manifest/ping), registry model/capability
  routing, mapping parity, and a loopback TCP round-trip (self-skips in
  sandboxes that refuse localhost binds and runs for real elsewhere);
  full monorepo typecheck/test/build green (6 packages); module-size gate
  green.

> **Follow-up (peer-serve review):** the `envoy-peer serve` CLI binary is
> shipped in `@envoymesh/envoy-harness-peer` (see
> `implementation-plan-chunk-v22.md` §4) — the D3-era "folded into D4"
> note in `distributed-collaboration.md` is superseded.

## Next

Chunk D4 — distributed team runner: `TeamConfig` agents gain
`host: "local" | "peer://<id>"`, dispatching over the shared subtask shape
(local via the team runner, peer via `PeerRegistry` + `PeerMeshSubmitter`).
