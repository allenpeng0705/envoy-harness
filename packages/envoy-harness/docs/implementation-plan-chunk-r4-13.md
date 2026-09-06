# Chunk R4.13 — Mesh-remote TerminalTransport

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 4 D-Mesh ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).

## Goal

Fill `terminal/remote.ts` so tools can follow the execution node via
`peer://` refs. Hermetic fake first; live peer/MAP wiring later.

## Changes

- `RemoteTerminalTransport` — `readOutput` / `read` / `getSession` /
  `listSessions` / `kill`
- Refs: `peer://<peerId>/terminals/<sessionId>`
- `FakeRemoteTerminalTransport` over `TerminalSessionService` + `viewer`
- `NOOP_REMOTE_TERMINAL_TRANSPORT` retained
- Exports + `test/terminal/remote.test.ts`

## Accept

- [x] Fake read / list / kill hermetically
- [x] Invalid refs → `RemoteTerminalError`
- [x] Package 1 stays peer-network-free

## Out of scope

- Remote `startSend` / spawn over the wire (coordinator can spawn via
  peer submit; follow-up)
- Auto-routing terminal tools on `peer://` ids
