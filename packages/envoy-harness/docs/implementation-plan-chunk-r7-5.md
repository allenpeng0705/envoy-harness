# Implementation plan chunk — R7.5 Resume picker + tests

> Part of Round 7 ([`implementation-plan-round-7.md`](./implementation-plan-round-7.md)).
> **Status:** done (2026-09-06). **Repos:** envoy-harness-ehui + EnvoyMesh.

## Delivered

### envoy-harness (`@envoymesh/envoy-harness-ehui`)

- Resume panel renders clickable `ehui-resume-row` buttons (not plain `<pre>`)
- `onResumeSession` threaded through `EhuiPanelContent` → `EhuiShell` / `EhuiPanelModal`
- Helpers `shortSessionId` / `resumeSessionTitle`; vitest `test/ehui-resume.test.ts`

### EnvoyMesh

- RPC `resumeEnvoyHarnessSession({ sessionId, chatId? })` remaps cwd→session, drops ACP host, returns history
- `EnvoyHarnessPanel` + narrow `EnvoyHarnessEhuiRail` wire `onResumeSession`
- Panel test: resume pick calls RPC with open `chatId` and loads transcript
- CSS for resume rows; fixed stray CSS after R7.4 media query

## Accept

- Resume list is actionable; chat transcript updates after pick
- Hermetic ehui tests; EnvoyMesh panel test covers host callback
