# Implementation plan chunk — R7.3 chatId-scoped EHUI invoke

> Part of Round 7 ([`implementation-plan-round-7.md`](./implementation-plan-round-7.md)).
> **Status:** done (2026-09-06). **Repo:** EnvoyMesh.

## Delivered (EnvoyMesh)

- `EhuiInvokeRequest` optional `chatId`
- `parseEhuiInvokeRequest` + `_ensureEnvoyHarnessPersistentAcpHost(chatId)`
- `createRemoteEhuiDataSource(..., { chatId })`
- Rail/panel/terminal pass open-thread chat id; terminal rail gets `refreshKey`

## Accept

Unit tests for parse + data-source chatId forwarding.
