# Chunk D5 — cross-instance verification + scoreboard

> **Status:** ✅ DONE (2026-08-22, working tree — pending user commit).
> Part of the **distributed-collaboration** major feature
> (`docs/distributed-collaboration.md`; `implementation-plan.md`
> §"Distributed collaboration").

## Goal

The verifier/reputation discipline joins the distributed story: an
orchestrator verifies a peer's result with a **different model** (routed by
model), and local scoreboards write `VerdictEntry` records (the shared mesh
schema — federatable into EnvoyMesh later).

## Changes (`packages/envoy-harness-peer/`)

- `verify.ts` — `createCrossInstanceVerifier(registry)`:
  `peer/verify` routed by `verifierModel` (`registry.pickByModel`) or an
  explicit `verifierPeerId`; returns `{ verdicts, verifierPeerId,
  verifierModel }`. The standalone analog of the mesh's chainVerify.
- `scoreboard.ts` — `PeerScoreboard`: record/list `VerdictEntry`,
  `reputationFor(peerId, skillId)` (pass/fail/partial counts + weighted
  score), `combinePeerVerdicts` (the mesh rule: OR-pass, AND-fail, else
  disputed).
- `verify-score.ts` — `createVerifiedScoreKeeper`: verify across a peer,
  combine the verdicts, write the `VerdictEntry` (`source: "llm"`,
  `verifierModel`, `issuedBy` = orchestrator) into the scoreboard.

## Tests (+5)

- Cross-instance verify routes to the requested model's peer; throws when
  none matches.
- Scoreboard aggregates reputation over pass/fail records.
- The combined verify-and-record flow writes a `VerdictEntry` with the
  verifier model and updates reputation.
- Verdict combination follows the mesh rule.

## Verification

- Peer suite green — tests cover cross-instance verification, scoreboard
  aggregation, and verdict combination; full monorepo green; typecheck
  clean; build done; module-size gate green.

## Next

Chunk D6 — EnvoyMesh combination: `RemoteSubmitterTransport` peer
implementation (a mesh node's `RemoteMeshSubmitter` can target the
standalone peer protocol — peer cluster as a mesh node's execution pool)
+ v2.2 libp2p transport.
