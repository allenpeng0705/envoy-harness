# Chunk R5.6 — U6a.5 Resume picker + image composer hint

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 5 ([`implementation-plan-round-5.md`](./implementation-plan-round-5.md)).

## Goal

Finish U6a product-shell: `/resume` picker panel and image paste hint
when the ACP host advertises image prompt capability.

## Changes (already largely in tree; locked by tests)

- `renderResumeView` + `/resume` → resume view in interactive screen
- Composer hint when `imagesSupported`
- Hermetic view test for resume picker

## Accept

- [x] Resume picker lists sessions
- [x] Image composer hint path present in UI

## Out of scope

- Ink/Blessed; mouse; pixel parity with Codex Rust TUI
