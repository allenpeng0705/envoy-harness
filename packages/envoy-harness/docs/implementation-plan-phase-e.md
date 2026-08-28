# Implementation plan — Phase E (items 10–11)

> Status: **DONE** locally 2026-08-22 (pending user commit).

## Scope

| Item | Deliverable |
|------|-------------|
| 10 ACP | `src/protocol/` — Content-Length JSON-RPC + `attachAcpServer` |
| 11 SDK | `attachSdkServer` + `packages/envoy-harness-client` (`EnvoyHarnessClient`) |

## Layout

```
packages/envoy-harness/src/protocol/
  types.ts, framing.ts, connection.ts, in-process.ts
  session-backend.ts, agent-backend.ts
  acp-server.ts, sdk-server.ts, index.ts

packages/envoy-harness-client/
  src/index.ts          # EnvoyHarnessClient
  test/client.test.ts
```

## Dialects

**ACP:** `initialize`, `authenticate`, `session/new`, `session/prompt`,
`session/cancel`; server→client `session/request_permission`;
notification `session/update` (committed messages only).

**SDK:** `session/create`, `session/prompt`, `session/cancel`,
`config/get`, `tools/list`; notification `session/event`.

Shared backend seam: `ProtocolSessionBackend` (+ fake for tests,
`createAgentSessionBackend` for Agent.run).

## Verification

- `pnpm exec vitest run test/protocol/protocol.test.ts` — 7 tests
- `packages/envoy-harness-client` vitest — 2 tests
- `tsc --noEmit` clean

## Out of scope (optional)

- Python SDK (until a consumer exists)
- Inline image prompts / editor-fs-terminal ACP capabilities
