# Chunk U5 — TUI polish: search, trace, accent theme

> **Status:** ✅ DONE (2026-08-23, working tree — pending user commit).

## What shipped (`@envoymesh/envoy-harness-tui`)

- **`/search <term>` view** — filters the transcript (case-insensitive)
  with a match count; Esc returns to chat. Plain mode renders the same
  as a status text.
- **`/trace` view** — the discovery/peer event log (newest first, with
  timestamps), backed by the session's event buffer (raised to 20).
- **Accent theme** — `RunInteractiveOptions.accent` / `ScreenOptions.accent`
  wraps the status bar in an ANSI SGR color (e.g. `"\x1b[36m"`).
- Composer edge fixed (found by e2e): Esc quickly followed by a char is
  parsed as an Alt+char keypress with no `ch` — the char now comes from
  `key.sequence`, so "leave view, then type" works.

## Tests

- Views: search filtering/count, trace ordering, cluster routing
  previews (views suite).
- Screen: accent wrap on the status row.
- TUI e2e: `/search` + `/trace` view switching with a discovery event
  in the ticker/trace; isolated session discovery subscription.

## Verification

- envoy-harness: typecheck ×6 + build ×6 green; full suite green
  (tui 41, peer 52, client 9, main 1567, adapter 151, cordis 21).
- EnvoyMesh: `tsc -b` clean; mappers + ACP-host suites green.

## Next

U6 (future): theming depth, transcript diff view, images, session
resume, memory/plan tabs — each needs protocol support first.
