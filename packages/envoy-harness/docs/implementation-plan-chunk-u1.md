# Chunk U1 — Envoy Harness UI protocol surface

> **Status:** ✅ DONE (2026-08-23, working tree — pending user commit).
> First chunk of the **Envoy Harness UI** major feature
> (`docs/envoy-harness-ui.md`; `implementation-plan.md` §"Envoy Harness
> UI"). The contract: every UI surface reads a protocol method.

## What shipped

**Protocol (ACP + SDK, Package 1)** — three additive optional methods on
`ProtocolSessionBackend`, each served by both dialects and consumed by
the client:

- `cluster/status` → `ProtocolClusterStatus` — peers + per-peer health
  (`ok`, `rttMs?`, `lastPingAt?`, `error?`) + connected/failed totals.
- `team/jobs` → `ProtocolTeamJob[]` — running/finished team runs with
  per-agent `host` (`local` | `peer://id`), model, status, cost.
- `scoreboard/summary` → `ProtocolScoreboardEntry[]` — reputation per
  `(workerPeerId, skillId)` (score + pass/fail/partial counts).

Hosts wire them like the existing `listPeers`/`getConfig` seams
(`createAgentSessionBackend` options + `createFakeSessionBackend`
fixtures). `discovery/events` (the notify stream) is deferred to U3 —
it needs the notification channel that lands with the U3 event stream.

**Client** (`@envoymesh/envoy-harness-client`) — `clusterStatus()`,
`teamJobs()`, `scoreboardSummary()` (typed, both dialects).

**TUI** (`envoy-harness-tui`) — `/cluster`, `/team`, `/scoreboard`
slash commands render the three surfaces as text (panels/rails arrive in
U2 with the ANSI screen module).

## Tests

- Client: SDK round-trip for all three methods; ACP empty fallbacks (2).
- TUI: `/cluster` health + totals, `/team` + `/scoreboard` rendering (2).
- Fake backend + agent-backend pass-through covered by the same suites.

## Verification

- envoy-harness: typecheck ×6 + build ×6 green; main 1567, client 6,
  tui 10 (full suite run below); module-size green.
- EnvoyMesh: `tsc -b` clean (the new backend methods are optional, so
  the in-process ACP host is unaffected).

## Next

U2 — TUI renderer v2 (ANSI screen module, composer upgrade, status bar,
cluster rail reading `cluster/status`; keymaps; hermetic render tests).
