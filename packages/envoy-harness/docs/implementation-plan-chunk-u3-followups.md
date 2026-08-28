# Chunk U3 follow-ups — lifecycle events + routing previews

> **Status:** ✅ DONE (2026-08-23, working tree — pending user commit).

## 1. Ongoing lifecycle events (discovery stream)

`PeerEvent` gained lifecycle types (`peer.connected`, `peer.failed`,
`peer.disconnected`, `peer.health`). `connectPeerClients` now emits
connected/failed per attempt and disconnected on `closeAll()` (including
validation failures). `buildHealthProvider` emits `peer.health` per ping,
and `createPeerUiBackend` forwards live peer events to
`discovery/subscribe` subscribers (the TUI's ticker/trace stay live).

Tests: cluster lifecycle events (injected connect), health-provider
events, backend forwarding (real ping → subscriber).

## 2. Routing previews inside `/cluster`

The cluster view now derives candidate tags from the connected peers'
capabilities and shows `route <tag> → <peer>` lines for each (cached 10s
so typing doesn't re-route per keystroke). `/route <tag>` remains the
manual preview.

Tests: `renderClusterView` with previews (views suite).
