# @envoymesh/envoy-harness-tui

Terminal host for **envoy-harness** — Codex-style interaction (composer,
transcript, approvals, slash commands) over the ACP dialect.

Package 1 stays UI-free; this sibling package is host **12a**. EnvoyMesh
Tauri (**12b**) will reuse the same ACP/SDK client later.

## Slash commands

**Mesh / collaboration** (type `/mesh` for the full setup guide):

- `/mesh` — onboarding: how to wire peers, configure flags, and use cluster views
- `/peers` — list connected peers (`peers/list`)
- `/cluster` — health + routing previews (`cluster/status` + `cluster/route`)
- `/team` — live team jobs (`team/jobs`)
- `/scoreboard` — peer reputation per skill (`scoreboard/summary`)
- `/route <tag>` — preview which peer would run a task
- `/trace` — discovery / peer event log

**Session / agent:**

- `/help` — list commands

## Screen mode (U2)

When both stdin/stdout are TTYs, `runInteractive` renders an ANSI
screen: status bar (session · model · mesh · /mesh or cluster n/m · busy), a
cluster rail (always visible — shows peers + health, or a `/mesh` hint when
empty), transcript window, and the composer input line.

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

Default binary uses an **in-process demo backend**; `--spawn` attaches
to a live `envoy-harness --acp` process (see "Running the dedicated UI"
below).

## Running the dedicated UI

The dedicated UI is a separate binary — it is **not** the plain
`envoy-harness` CLI. Three ways to launch it:

1. **Demo (no setup, no model):**
   ```bash
   pnpm --filter @envoymesh/envoy-harness-tui start
   # or, from the built package: envoy-harness-tui
   ```
   Screen mode activates automatically when stdin/stdout are a TTY:
   status bar (session · model · cluster n/m · busy), cluster rail,
   transcript, composer. Type `hello` to chat with the echo backend,
   `/cluster` `/team` `/scoreboard` `/route research` `/trace` to see the
   distributed views, `/help` for the palette, `/quit` to exit.

2. **Against a real harness (model) + optional mesh:**
   ```bash
   pnpm --filter @envoymesh/envoy-harness-tui exec tsx src/bin.ts --spawn \
     --provider openai --peers w1@127.0.0.1:18123
   # ENVOY_HARNESS_BIN=/path/to/envoy-harness to override the harness
   # ENVOY_PEERS=w1@127.0.0.1:18123  (alternative to --peers)
   ```
   This spawns `envoy-harness --acp` (with peers wired into the ACP
   backend) and attaches the TUI over stdio.

3. **Cluster console via TUI (no EnvoyMesh):**
   ```bash
   # terminal 1 — start a peer:
   pnpm --filter @envoymesh/envoy-harness-peer exec tsx bin/envoy-peer.ts serve \
     --port 18123 --peer-id p1 --model deepseek-chat
   # terminal 2 — cluster console (chat echoes hint):
   pnpm --filter @envoymesh/envoy-harness-tui exec tsx src/bin.ts \
     --cluster-only --peers p1@127.0.0.1:18123
   # or the envoy-peer CLI wrapper:
   pnpm --filter @envoymesh/envoy-harness-peer exec tsx bin/envoy-peer.ts ui \
     --peers p1@127.0.0.1:18123
   ```
   You'll see the live cluster rail (`p1[deepseek-chat][rtt=1ms]`), the
   discovery ticker (`! p1 connected`), and real data in `/cluster`,
   `/route`, `/scoreboard`, `/trace`.

When a mesh node has `envoyHarnessPeers` configured, its in-process ACP
host serves the same methods — attach any `envoy-harness-tui` to it for
the cluster rail + views against the mesh's peer pool.

## Programmatic

```ts
import { createInProcessTui } from "@envoymesh/envoy-harness-tui";

const tui = createInProcessTui();
await tui.session.start();
await tui.session.submit("hello");
console.log(tui.session.renderTranscript());
tui.close();
```
