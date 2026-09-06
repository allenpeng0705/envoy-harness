# Chunk R5.5 — U6a.4 Permission modal polish

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 5 ([`implementation-plan-round-5.md`](./implementation-plan-round-5.md)).

## Goal

Scrollable permission diff preview (j/k / PgUp/PgDn) while a tool
permission is parked.

## Changes

- `formatPermissionBlock` — `previewOffset` / window + scroll hint
- `scrollPermissionPreview` on `TuiSession`
- Screen UI keys scroll preview while pending
- Hermetic transcript tests

## Accept

- [x] Long previews show a window, not only a truncate footnote
- [x] Offset scroll changes visible lines
