# Chunk R4.16 — ACP / Codex / Claude as workers

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 4 D-Interop ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).

## Goal

*Their* agents, *our* distribution: register external workers
(ACP / Codex / Claude) on the R4.15 {@link SubagentProviderRegistry}
so `task` / workflow keep one `MeshSubmitter` surface.

## Changes

- `src/subagent/external-worker.ts` —
  `ExternalWorkerTransport`, `createExternalWorkerSubmitter`,
  `registerExternalWorker`, `FakeExternalWorkerTransport`
- Capability-tag filtering via `canHandle`
- Hermetic tests (no real Codex/Claude SDKs)

## Accept

- [x] Register multiple external kinds on one registry
- [x] Route by `capabilityTag` / `preferredProviderId`
- [x] Transport errors → `failed` `SubagentResult`

## Out of scope

- Shipping real Codex CLI / Claude Code / ACP stdio adapters
  (hosts inject `ExternalWorkerTransport`)
- Continuable external workers
