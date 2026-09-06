# Implementation plan chunk — R8.1 default LocalMeshSubmitter

> Part of Round 8 ([`implementation-plan-round-8.md`](./implementation-plan-round-8.md)).
> **Status:** done (2026-09-06).

## Delivered

- `cli/run/build-local-mesh-submitter.ts` — recursive local mesh for CLI
- Wired in one-shot, REPL, ACP `createAgent`
- `--no-subagents` opt-out (default: sub-agents on)
- `defaultBuildSubagentFactory` accepts optional `meshSubmitter`
- Tests: `test/cli/build-local-mesh-submitter.test.ts`

## Accept

Standalone `envoy --repl` / one-shot / `--acp` register `task` unless `--no-subagents`.
