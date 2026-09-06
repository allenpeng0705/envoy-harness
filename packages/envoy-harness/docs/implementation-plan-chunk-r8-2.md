# Implementation plan chunk — R8.2 long-run + peers parity

> Part of Round 8 ([`implementation-plan-round-8.md`](./implementation-plan-round-8.md)).
> **Status:** done (2026-09-06).

## Delivered

- REPL default `--max-turns` **200** when unset (one-shot stays 50)
- REPL does **not** apply the one-shot `$5` cost ceiling by default
- Interactive TTY REPL **auto-persists** (prints resume id); tests with
  injected `lineReader` stay in-memory
- `resolveAgentRuntimeConfig` sandbox policy wired in REPL (parity with
  one-shot / ACP)
- `cli/run/wire-cli-peers.ts` + wired in one-shot and REPL dispatch
- Help / QUICKSTART long-run notes (presets, job_start / bash timeoutMs)

## Tests

`test/cli/r8-2-longrun.test.ts`

## Accept

Multi-hour REPL with intermittent `/preset` permissions and resume after
restart is a documented, default-friendly path; `--peers` connects on
REPL/one-shot, not only ACP.
