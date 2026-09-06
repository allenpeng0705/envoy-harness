# Implementation plan chunk — R8.3 envoy-harness-web scaffold

> Part of Round 8 ([`implementation-plan-round-8.md`](./implementation-plan-round-8.md)).
> **Status:** done (2026-09-06).

## Delivered

- New package `@envoymesh/envoy-harness-web` (Vite + React)
- Node bridge: HTTP static/dev + WebSocket `/ws/acp` → spawn
  `envoy-harness --acp` (Content-Length frame relay)
- Browser health page: ACP `initialize` + `session/new`
- CLI: `envoy-harness-web` / `envoy-harness web`
- Hermetic bridge/frame tests

## Accept

`pnpm --filter @envoymesh/envoy-harness-web start` opens localhost UI
talking to a live harness process.
