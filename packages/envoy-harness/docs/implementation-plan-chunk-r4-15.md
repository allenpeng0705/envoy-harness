# Chunk R4.15 — Subagent provider registry

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 4 D-Interop ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).

## Goal

Named providers (`local` | `peer` | `external`) behind one
`MeshSubmitter` / `task` surface so hosts can mix local, peer cluster,
and future ACP/Codex workers without forking the tool API.

## Changes

- `src/subagent/provider-registry.ts` —
  `SubagentProviderRegistry` implements `MeshSubmitter`
- Routing: `preferredProviderId` → `preferredPeerId` (peer kind) →
  explicit `canHandle` match → open providers → default `"local"`
- `SubagentInput.preferredProviderId`
- Hermetic tests; Package 1 stays peer-network-free (peer submitter
  injected by host)

## Accept

- [x] Register local + peer + external; one `submit()` surface
- [x] Preferred provider / peer / canHandle routing
- [x] Duplicate id + missing preferred → typed errors

## Out of scope

- R4.16 concrete ACP/Codex/Claude worker adapters
- Auto-wiring peer package into Package 1
