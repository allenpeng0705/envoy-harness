# Chunk U4 — EnvoyMesh host wiring + dedicated UI panel

> **Status:** ✅ DONE (2026-08-23, working tree — pending user commit).
> The desktop *panels* were deferred Tauri-team work (v1.12/v1.15); this
> chunk ships both the host-side contract AND the first dedicated
> desktop surface (the social app's terminal view).

## What shipped (EnvoyMesh)

The in-process ACP host's backend (used by `ENVOY_HARNESS_TRANSPORT=acp`
and the Pi-coding-backend path) now serves every dedicated-UI method:

- `listPeers` / `clusterStatus` / `routePeer` — from the configured
  `envoyHarnessPeers` pool via `createPeerPoolStatusBackend` (peer
  package; added U3).
- `teamJobs` — **new**: the local chain worker's subtasks grouped per
  chain (`chainWorkerSubtasksToTeamJobs`), so `/team` shows live
  chain-worker jobs.
- `scoreboardSummary` — **new**: every signed verdict across all chain
  arbitration stores, aggregated per `(workerPeerId, skillId)`
  (`listAllVerdictEntries` + the peer package's `aggregateVerdicts`).

Pure mappers (`chainWorkerSubtasksToTeamJobs`, `listAllVerdictEntries`)
are exported from `node-service-chain-orchestration.ts`; `aggregateVerdicts`
is shared with the standalone `envoy-peer ui`.

**Dedicated UI panel (apps/social).** `EnvoyHarnessPanel.tsx` — the
first-class "envoy-harness" surface in the desktop app (the way
PiChatPanel is Pi's). TerminalView renders it instead of PiChatPanel when
`piSettings.codingBackend === "envoy-harness"`. The panel shows:

- runtime status badge (ready/starting/disabled/error) + model from the
  new `getEnvoyHarnessStatus` RPC;
- a peer-cluster strip + counts (`listEnvoyHarnessPeers`) — the
  configured execution pool (Pattern A);
- chat turns via the `askEnvoyHarness` RPC (same runtime path as
  `sendToPi`, 120s budget).

The three RPCs are owner-only, registered in `json-rpc-router.ts` and
bridged through `useNodeService` + `DirectCallClient`.

## Tests

`apps/node/test/envoy-harness-ui-mappers.test.ts` — subtask→job grouping
and verdict aggregation (2 suites). Peer package `aggregateVerdicts`
shares the peer-ui aggregation coverage.

`apps/social/test/components/EnvoyHarnessPanel.test.tsx` — status badge,
cluster strip, submit + response, not-ready hint, RPC error (4).
`apps/node/test/owner-only-rpc.test.ts` — the three Envoy Harness RPCs
are owner-gated.

## Verification

- EnvoyMesh: `tsc -b` clean (forced full recheck), mappers + ACP-host
  suites green.
- envoy-harness: full suite green (below).

## Next

U5 polish landed (search view, trace view, accent theme —
`implementation-plan-chunk-u5.md`). Remaining: EnvoyGo panels + a
dedicated permission/proposal dock for envoy-harness tool calls (the
panel is plain-text chat for now; tool approvals reuse the Pi auto-run
policy until a dedicated `eh:` proposal bridge lands).

## U4+ — Ext Agent-style UX + Codex/Claude TUI UX (2026-08-23)

**Two entry points for Envoy (2026-08-23 user decision).** The dedicated
surface is now a first-class agent with TWO entries, mirroring Pi:

- **Chat list "Envoy"** — a chat thread (`ENVOY_HARNESS_THREAD_KEY`)
  rendering the Envoy chat panel in the chat area (like EnvoyAI / Ext
  Agent): status badge, model, project folder, peer cluster, `/`
  command suggestions. Label is "Envoy" (subtitle "Coding Agent (ACP)")
  — friendly name, disambiguated from EnvoyAI by the subtitle.
- **Terminal** — the existing Terminal view keeps the panel chat pane as
  a fallback; spawning the standalone `envoy-harness-tui` as a real TUI
  terminal session (like Pi's PTY) is the next chunk.

**Terminal TUI (2026-08-23, user direction).** The terminal surface is
now TUI-based like Pi's:

- `apps/node/src/envoy-terminal-session.ts` — `ensureEnvoyTerminalSession`
  spawns `envoy-harness-tui --spawn --provider <p> --model <m>` in a
  reserved TerminalManager session (`role: "envoy-harness"`) with the
  project folder as cwd and the provider API key in the env (mirrors
  `pi-terminal-session.ts`). TerminalManager gained generic
  `listSessionsByRole` / `findSessionByCwd` helpers.
- The TUI's `--spawn` mode now forwards `--provider`/`--model` to the
  harness (`spawn.ts` `resolveHarnessAcpCommand(extraArgs)`), so the
  spawned session boots a live model.
- TerminalView: when the coding backend is envoy-harness, the terminal
  sidebar's primary button is **"Envoy"** and starts the TUI; the
  project-folder modal is reused (Envoy-branded). The Envoy chat panel
  stays on the Chat list; the terminal's chat pane is Pi-only.
- Layout fix: `.assistant-chat-wrapper` now uses `flex: 1 1 0%` so the
  Envoy panel's composer pins to the bottom instead of collapsing to
  content height.

**Social panel (apps/social):**
- **Slash-command helper** — typing `/` shows a suggestion palette
  (`/help /clear /status /peers`) with descriptions; commands run
  client-side (like Ext Agent's local `/help`). Lib:
  `lib/envoy-harness-slash-commands.ts`.
- **Project folder selection** — the panel shows the runtime's `cwd`
  and a folder input + Set button. New owner-only RPC
  `setEnvoyHarnessProjectPath` validates the directory, persists
  `envoyHarnessCwd` in node config, resets the runtime cache (next ask
  runs in the new folder), and returns the refreshed status (which now
  includes `cwd`).

**TUI (envoy-harness-tui) — Codex/Claude-style:**
- **Slash palette** — typing a `/prefix` opens a filtered command
  palette above the composer; ↑/↓ navigate, Enter selects, Esc closes,
  Tab completes.
- **Multi-line composer** — Shift+Enter / Alt+Enter / kitty
  `\x1b[13;2u` insert a newline; plain Enter submits (Claude Code
  style). The screen lays out the composer across multiple bottom rows
  and keeps the cursor on the active line.

Tests: panel slash suggestions + project folder (2), owner-only gating
(incl. `ensureEnvoyTerminalSession`), config round-trip, ChatSidebar
Envoy row (1), `envoy-terminal-session` spawn/reuse/project (3), TUI
spawn arg forwarding (1); composer newline keys (3), screen multi-line/
palette layout + cursor (2), TUI palette e2e (1).
