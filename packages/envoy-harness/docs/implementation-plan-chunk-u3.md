# Chunk U3 — distributed detail views + discovery stream + `envoy-peer ui`

> **Status:** ✅ DONE (2026-08-23, working tree — pending user commit).
> Third chunk of the **Envoy Harness UI** major feature
> (`docs/envoy-harness-ui.md`).

## What shipped

**Detail views (TUI screen mode).** `/cluster`, `/team`, `/scoreboard`,
`/peers`, and the new `/route <tag>` now switch the screen into a
dedicated view (Esc returns to chat; a plain message while in a view
returns to chat and submits). View bodies are pure renderers
(`src/views.ts`), hermetic-tested. The discovery ticker shows the last
events above the input in every view. Plain (non-TTY) mode keeps the U1
text behavior.

**Discovery event stream (protocol).** `discovery/subscribe` on ACP+SDK
pushes `discovery/event` notifications from an optional
`ProtocolSessionBackend.subscribeDiscovery` seam; the client exposes
`subscribeDiscovery(listener)` with a notification handler registry
(registered before the request so initial replays aren't missed).

**Routing preview (protocol).** `cluster/route` — `routePeer?(
{ capabilityTag, preferredPeerId? })` on the backend + client
`routePeer()`. The `/route <tag>` view shows which peer would run the
task.

**`envoy-peer ui` (standalone cluster console).** A new `ui` subcommand
connects `--peers <id>@<host:port>` (repeatable), builds the peer
registry + health pinger (lazy RTT with TTL cache), serves
`listPeers` / `clusterStatus` / `routePeer` / `scoreboardSummary` /
`subscribeDiscovery` over an in-process ACP server, and runs the
dedicated TUI. Chat isn't wired (a peer has no model) — the console
backend echoes a hint; attach `envoy-harness --acp` for the coding-agent
surface. The peer package now depends on the TUI package (no cycle).

**EnvoyMesh wiring.** The in-process ACP host's backend now spreads
`createPeerPoolStatusBackend(pool)` (peer package) when an
`envoyHarnessPeers` pool is configured — the TUI's cluster rail, `/cluster`,
and `/route` read the mesh node's real peer pool over the same contract.

## Tests

- Protocol/client: discovery subscribe replay + unsubscribe; cluster/route
  round-trip (client 7).
- TUI: view renderers (cluster/route/peers/team/scoreboard/ticker),
  screen-mode view switching e2e (`/cluster` → view, Esc → chat,
  `/route research` → routing preview), Alt+char composer fix for the
  Esc-then-type case (tui 36).
- Peer: `envoy-peer ui` args, cluster-status mapping, pool-status backend,
  scoreboard aggregation, health pinger, discovery replay (peer 49).

## Verification

- envoy-harness: typecheck ×6 + build ×6 green; full suite 1831 tests
  (main 1567, adapter 151, peer 49, cordis 21, tui 36, client 7);
  module-size green.
- EnvoyMesh: `tsc -b` clean; ACP-host / peer-pool / runtime /
  harness-submit suites green (37).

## Next

U4 — EnvoyMesh desktop/EnvoyGo panels over the same protocol (Tauri
team), and U5 polish (theming, search, diff, images, session resume,
trace panel). Deferred U3 follow-ups: ongoing lifecycle events from peer
reconnects (needs peer-event plumbing) and routing preview defaults in
`/cluster`.
