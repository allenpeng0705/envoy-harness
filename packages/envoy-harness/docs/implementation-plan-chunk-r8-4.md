# Implementation plan chunk — R8.4 WebUI MVP surfaces

> Part of Round 8 ([`implementation-plan-round-8.md`](./implementation-plan-round-8.md)).
> **Status:** done (2026-09-06).

## Delivered

- Browser `AcpHost` over WS JSON-RPC
- Chat transcript + composer (`session/prompt`, updates, cancel)
- Permission + user-question modals
- Model / provider + sandbox / approval / auto-run settings
- Session list + resume (`sessions/list`, `session/load`)
- Status strip (model, cwd, peers, busy)
- Keys stay on the Node bridge / env (not browser storage)

## Accept

Change model, approve a tool, chat, cancel, resume — entirely in the browser.
