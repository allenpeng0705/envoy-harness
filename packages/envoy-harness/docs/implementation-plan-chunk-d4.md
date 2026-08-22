# Chunk D4 — distributed team runner

> **Status:** ✅ DONE (2026-08-22, working tree — pending user commit).
> Part of the **distributed-collaboration** major feature
> (`docs/distributed-collaboration.md`; `implementation-plan.md`
> §"Distributed collaboration").

## Goal

A single team job spans machines/models: `TeamConfig` agents gain a
`host` field (`"local"` default, or `"peer://<peerId>"`), and the team
runner dispatches peer-hosted agents through a host-supplied seam — the
peer package provides the implementation, so Package 1 stays free of it.

## Changes

**Package 1 (`@envoymesh/envoy-harness`)**
- `src/team/types.ts` — `AgentSpec.host?: string` (D4 doc).
- `src/team/toml.ts` — parses optional `host` (string; rejects others).
- `src/team/runner.ts` — `TeamOptions.peerExecutor?: (spec, prompt) =>
  Promise<string>`; `runAgent` dispatches `host !== "local"` agents to the
  executor (clear error when absent). Local agents unchanged.

**Peer package (`@envoymesh/envoy-harness-peer`)**
- `src/team.ts` — `createPeerTeamExecutor(registry, opts?)`: parses
  `peer://<id>`, resolves via `PeerRegistry`, submits via
  `PeerMeshSubmitter` (task = the agent's prompt, capabilityTag = role,
  preferredPeerId = the host id), returns the result text. Plus
  `createSinglePeerTeamExecutor` convenience.

## Behavior

- A team with a mix of local + peer agents runs both in topological order;
  upstream context flows the same way regardless of host.
- Peer agents never touch the local model (verified by tests).
- A peer host without `peerExecutor` fails that agent with a clear error
  ("requires TeamOptions.peerExecutor … createPeerTeamExecutor").

## Tests

- Package 1: peer-hosted agent dispatches through a spy executor (local
  agent still runs locally); missing executor → clean failure; TOML parses
  `host` and rejects non-strings.
- Peer package: `createPeerTeamExecutor` over the in-process pair — a
  `peer://p1` team agent runs on the peer (stub adapter) and its text
  lands in the team result.

## Verification

- `pnpm -r typecheck` clean (6 packages); `pnpm -r test` green
  (envoy-harness 1567, peer 10, others unchanged; total 1754); build done
  ×6; module-size gate green (240 files, 0 over cap).

## Next

Chunk D5 — cross-instance verification + scoreboard: standalone
`peer/verify` with a different model (reuse the verifier + v1.16 hint) and
local scoreboards writing `VerdictEntry` (federatable into the mesh later).
