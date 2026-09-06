# Chunk R4.1 — Async / non-blocking user questions

> **Status:** IMPLEMENTED (2026-09-05).
> Part of Round 4 D-Refine ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).
> Design: [`distributed-collaboration.md`](./distributed-collaboration.md) §11.2.

## Goal

Park structured human questions (`ask_user`, plan mode) on the ACP/TUI
host the same way permissions already work: the agent turn stays busy,
but the host composer can still queue follow-ups and answer (or Esc-cancel)
without fighting stdin.

## Changes

### Package 1 (`envoy-harness`)

- `src/interaction/providers/host-bridge.ts` — `createHostBridgeUserQuestionProvider`
  forwards `ask()` to a host callback with a `questionId`.
- `src/protocol/session-backend.ts` — `ProtocolUserQuestionRequest` /
  `ProtocolUserQuestionAnswer`; optional `requestUserQuestion` on prompt params.
- `src/protocol/agent-backend.ts` — per-session host-bridged `userQuestions`;
  cancel/abort resolves pending question waiters.
- `src/protocol/acp-server.ts` + `sdk-server.ts` — server → client
  `session/user_question` JSON-RPC request (5-minute ceiling).
- `src/cli/run/acp.ts` — Agents use backend-provided `userQuestions`
  (no stderr stdin provider for TUI hosts).

### Client + TUI

- `@envoymesh/envoy-harness-client` — `onUserQuestionRequest` handler.
- `@envoymesh/envoy-harness-tui` — `pendingUserQuestion`,
  `handleUserQuestionRequest` / `answerUserQuestion` / `cancelUserQuestion`;
  composer answers questions while busy; Esc cancels; follow-up queue unchanged
  when no question is pending.

## Tests

- `test/interaction/host-bridge.test.ts` — no-host, forward, abort.
- `test/protocol/{framing,acp-server,sdk-server,agent-session-backend,jsonrpc-connection,permission-ask-hook}.test.ts`
  — park until host answers; cancel unblocks; ACP + SDK `session/user_question`
  round-trips (fake backend).
- `envoy-harness-tui/test/user-question.test.ts` — answer / cancel waiters.

## Review follow-ups (2026-09-06)

- Split `agent-backend-host.ts`, `acp-params.ts`, `host-request.ts` (module-size).
- Shared ACP/SDK host permission + user-question helpers.
- TUI surfaces `recommendedIndex` as `(recommended)` on options.
- Fixed pre-existing `repl-tier2` compact count (3, not 4) + command table size.
- Module-size: split `cli/argv.ts`, package `index.ts` barrels, TUI `session.ts`.
- §4c: canonical wire types `HostUserQuestionRequest` /
  `HostUserQuestionAnswer`; `Protocol*` aliases; client/TUI reuse.
- §4g: split `protocol.test.ts` into framing / acp / sdk / agent-backend /
  jsonrpc / permission-ask-hook suites.

## Accept

- [x] Busy turn + pending question: host can answer without ending the prompt RPC
- [x] Cancel / Esc resolves the parked question as cancelled
- [x] Follow-up input queue still applies when busy and no question pending
- [x] Hermetic tests (no live LLM)

## Out of scope (later chunks)

- EHUI React dock (EnvoyMesh / EnvoyGo already have related docks)
- REPL stdin queue while ask_user blocks (REPL stays sync)
