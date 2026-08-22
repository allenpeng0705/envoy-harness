# Chunk U2 — TUI renderer v2 (screen, composer, status bar, cluster rail)

> **Status:** ✅ DONE (2026-08-23, working tree — pending user commit).
> Second chunk of the **Envoy Harness UI** major feature
> (`docs/envoy-harness-ui.md`).

## What shipped (`@envoymesh/envoy-harness-tui`)

**`screen.ts` — the ANSI screen module.** Fixed-region layout (status
bar, optional cluster rail, transcript window, input line), diff-based
rendering (only changed rows are rewritten), pure layout helpers
(`layoutRows`, `buildStatusLine`, `buildRailLine`, `fitLine`) that are
hermetic-tested without a TTY. No TUI framework dependency.

**`composer.ts` — the keymap-driven composer.** Line editing (cursor
left/right, backspace), history (up/down arrows), slash tab-completion,
Enter submit, Esc / Ctrl-C cancel, Ctrl-U clear, Ctrl-D exit. Pure and
directly testable.

**`ui.ts` — two modes.** Screen mode (TTY): renders the status bar
(session · model from `config/get` · cluster n/m · busy), the cluster
rail (`peers: p1(model)[rtt=12ms] p2[down]` refreshed from
`cluster/status` before each render), the transcript window, and the
composer. Plain mode (pipes/CI): the legacy readline loop, unchanged.

**Status bar model source.** `createAgentSessionBackend` gained a
`getConfig` seam; the `--acp` dispatch now serves `{ model }` from
`--provider`/`--model`, so the status bar shows the live model label.
`TuiSession` gained `refreshCluster()` + `getModelLabel()`.

## Tests

- `screen.test.ts` (9): truncation, layout/window math, status + rail
  builders, diff renderer (identical redraw = cursor move only; changed
  row rewritten).
- `composer.test.ts` (9): typing, backspace/cursor, history, Esc/Ctrl-C/
  Ctrl-D/Ctrl-U, empty-submit dedupe, slash completion.
- `tui.test.ts` (+1): end-to-end interactive screen mode driven by raw
  keypresses (type → Enter → transcript rendered → `/quit` exits).

## Verification

- envoy-harness: typecheck ×6 + build ×6 green; full suite 1816 tests
  (main 1567, adapter 151, peer 42, cordis 21, tui 29, client 6);
  module-size green.
- EnvoyMesh: `tsc -b` clean (backend changes are additive).

## Next

U3 — distributed detail views (`/cluster`, `/team`, `/scoreboard`
panels + discovery event stream) and the standalone `envoy-peer ui`
entry (peer registry + ACP server + TUI in one process).
