# Chunk R5.3 — Discovery rail on CLI / ACP

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 5 ([`implementation-plan-round-5.md`](./implementation-plan-round-5.md)).

## Goal

Plug R4.18 `createDiscoveryRail` into production cluster wiring and expose
`--discovery static|mdns|none` on the CLI.

## Changes

- `wirePeerCluster({ discovery })` — static peers via `StaticDiscoverySource` + rail
- `--discovery` argv (default `static`); help text
- ACP run path passes `parsed.discovery`; TUI `wireClusterBackend` accepts it

## Accept

- [x] Default `static` uses discovery rail (not raw `connectPeers`)
- [x] `none` skips auto-connect; runtime `connectPeer` remains
- [x] `mdns` adds placeholder `MdnsDiscoverySource` alongside static

## Out of scope

- Real OS Bonjour browser
