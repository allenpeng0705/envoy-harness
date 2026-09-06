# Chunk R4.18 — Dynamic discovery beyond static `--peers`

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 4 D-Ops ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).
> Design: [`distributed-collaboration.md`](./distributed-collaboration.md) discovery table.

## Goal

Pluggable discovery sources (static | mDNS | mesh feed | fake) feed a
rail that updates `ManagedPeerCluster`. ACP `discovery/subscribe` already
forwards `peer.connected` / `peer.failed` / `peer.disconnected` from the
cluster event sink — no new notify shape required for v1.

## Changes

### Peer package

- `discovery.ts` — `DiscoverySource` + `StaticDiscoverySource`,
  `FakeDiscoverySource`, `MeshFeedDiscoverySource`, `MdnsDiscoverySource`
  (injectable browser), `CompositeDiscoverySource`
- `discovery-rail.ts` — `createDiscoveryRail({ cluster, sources })`
  serializes `found` → `connectPeer`, optional `lost` → `disconnectPeer`
- `ManagedPeerCluster.disconnectPeer(id)` for revoke paths

## Accept

- [x] Fake discovery source publishes peer; cluster rail updates hermetically
- [x] Static source connects on start
- [x] Mesh feed + mDNS browser share the same rail (fail-open)

## Out of scope

- Real Bonjour / zeroconf OS integration (inject browser later)
- Automatic CLI `--discovery=mdns` flag wiring
- New ACP discovery event types beyond existing peer lifecycle
