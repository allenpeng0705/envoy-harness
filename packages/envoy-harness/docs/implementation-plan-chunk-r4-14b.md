# Chunk R4.14b — Exec-world on peer

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 4 D-Mesh ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).

## Goal

Coordinator keeps the model loop local; FS/shell tools can target a
worker peer (Codex exec-server *idea*) via an injected
{@link RemoteExecTransport}.

## Changes

- `src/exec-world/` — `ExecWorld`, `createLocalExecWorld`,
  `createPeerExecWorld`, `FakeRemoteExecTransport`
- `ToolContext.execWorld` + `AgentOptions.execWorld` + tool-executor passthrough
- `read_file` / `write` / `bash` delegate when `execWorld` is set
- Peer background bash rejected with a clear error (v1)

## Accept

- [x] Hermetic fake: read/write/bash hit peer transport
- [x] Package 1 stays peer-network-free
- [x] Local tools unchanged when `execWorld` unset

## Out of scope

- Live MAP `peer/exec/*` RPC (adapter / peer package)
- Background jobs on peer exec-world
- Auto-routing `edit` / `git` through exec-world (follow-up)
