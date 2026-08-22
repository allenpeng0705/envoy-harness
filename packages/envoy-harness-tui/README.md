# @envoymesh/envoy-harness-tui

Terminal host for **envoy-harness** — Codex-style interaction (composer,
transcript, approvals, slash commands) over the ACP dialect.

Package 1 stays UI-free; this sibling package is host **12a**. EnvoyMesh
Tauri (**12b**) will reuse the same ACP/SDK client later.

## Slash commands

- `/help` — list commands
- `/peers` — list the host's connected peer cluster (`peers/list` over
  ACP: `id`, `model`, `capabilities`; empty state when the host has no
  peers). The standalone CLI has no peers of its own — hosts that embed
  the ACP server (e.g. EnvoyMesh's in-process ACP host) wire their peer
  registry through `ProtocolSessionBackend.listPeers()`.
- `/cluster` — cluster status view: per-peer health/RTT + routing
  previews (`cluster/status` + `cluster/route`)
- `/team` — live team jobs (local + peer agents) (`team/jobs`)
- `/scoreboard` — peer reputation per skill (`scoreboard/summary`)
- `/route <tag>` — preview which peer would run a task
- `/search <term>` — search the transcript (match count)
- `/trace` — the discovery/peer event log
- `/cancel` — abort the in-flight prompt
- `/quit` — exit

## Screen mode (U2)

When both stdin/stdout are TTYs, `runInteractive` renders an ANSI
screen: status bar (session · model · cluster n/m · busy), a cluster
rail (peers + model + health RTT, refreshed from `cluster/status`), a
transcript window, and the composer input line.

Keymaps:

- Enter — submit
- Esc / Ctrl-C — cancel the in-flight prompt (or clear the input)
- ↑ / ↓ — prompt history
- Tab — slash-command completion
- Ctrl-U — clear the input
- Ctrl-D (empty input) — exit

Pass `accent` (e.g. `"\x1b[36m"`) to `runInteractive` to color the
status bar.

Pipes/CI fall back to the plain readline loop (transcript lines printed
as they arrive).

## Quick start

```bash
pnpm --filter @envoymesh/envoy-harness-tui test
pnpm --filter @envoymesh/envoy-harness-tui exec tsx src/bin.ts
```

Default binary uses an **in-process demo backend**. Attaching to a live
harness `--acp` stdio process lands when that CLI entry exists.

## Programmatic

```ts
import { createInProcessTui } from "@envoymesh/envoy-harness-tui";

const tui = createInProcessTui();
await tui.session.start();
await tui.session.submit("hello");
console.log(tui.session.renderTranscript());
tui.close();
```
