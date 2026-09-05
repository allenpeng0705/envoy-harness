# Chunk R4.8 — Parallel DAG in Team runner

> **Status:** IMPLEMENTED (2026-09-05).
> Part of Round 4 D-Refine + D-Ops ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).

## Goal

Run ready agents concurrently (wave scheduling on `dependsOn`), with
optional retries. Works for all-local teams (no peers required).

## Changes

- `TeamOptions.parallel` (default **true**) — wave-based
  `Promise.all` for agents whose deps are complete
- `TeamOptions.parallel: false` — classic sequential topo order
- `TeamOptions.maxRetries` — re-run aborted/thrown agents
- Existing topo sort still validates cycles / missing deps

## Tests

- Diamond DAG: B∥C after A; `maxInFlight >= 2`
- `maxRetries: 1` recovers from first-call model throw
- Existing chain / fan-out / failure tests still green

## Accept

- [x] Diamond DAG concurrent with fakes
- [x] No peers required
