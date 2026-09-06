# Envoy Harness UI (EHUI) - the dedicated envoy-harness interface

Status: U1-U5 DONE; U6a DONE (Round 5); F2 lifecycle DONE (Round 6; FS
isolation skipped). **U6b EHUI refine — Round 7**
([implementation-plan-round-7.md](./implementation-plan-round-7.md)).
See [ehui-panel-spec.md](./ehui-panel-spec.md).

**EnvoyMesh mapper swap (R5.4):** hosts that injected `FakeRemoteJobTransport` /
`FakeRemoteExecTransport` should swap to adapter factories
`createPeerRemoteJobTransportFromRegistry` /
`createPeerRemoteExecTransportFromRegistry` (same pattern as
`createPeerRemoteSubmitterTransport`). UI mappers stay in the EnvoyMesh repo.

## 1. Vision

envoy-harness's differentiator is **distribution and collaboration** -
agents on different machines, different models, verifier discipline,
reputation, federation. Its UI should make that first-class, not an
afterthought. Today envoy-harness has no dedicated UI: EnvoyGo/Tauri
drive it through Pi's chat/proposal surface
(`piSettings.codingBackend === "envoy-harness"` -> `pi:proposal` +
`session/update`), and `envoy-harness-tui` is a minimal readline host
(transcript + `/peers` + permissions).

**Goal:** a dedicated envoy-harness UI - a rich terminal first (the
agent's daily surface), then desktop/EnvoyGo panels - that is
substantially better than Pi's terminal for **coding-agent power**
(composer, plan, memories, tools, permissions) AND for **distributed
features** (peer discovery, cluster health, model routing, live team
jobs, verification/scoreboard, federation). Sharing Pi's chat surface
stays; the dedicated UI is the differentiated one, and it gets better
round by round.

## 2. Current state

- **Protocol (ACP/SDK, Package 1):** `session/new|create`, `session/prompt`,
  `session/cancel`, `session/compact`, `session/set_model`, `session/set_policy`,
  `git/diff`, `git/status`, `tools/list`, `config/get`, `peers/list`;
  notifications `session/update` (mid-run messages), `session/token` (assistant
  text deltas), `session/activity` (live tool/sub-agent progress incl.
  `tool_progress` bash stdout, terminal send/read, MCP progress), `session/event`
  (SDK); permissions via `session/request_permission`. Session ops:
  `session/compact` (incl. `--summarize`), `session/plan`, `session/memory`,
  `session/review`,
  `session/init`, `session/hooks`, `session/mcp`, `session/agents`,
  `session/context`, `git/diff`, `git/status`.
- **TUI (`envoy-harness-tui`):** composer, transcript with live tool lines,
  slash palette (compact, provider, sandbox, approval, diff, git-status, mesh),
  permission allow/deny with edit/write diff preview, in-process +
  attached + spawned modes.
- **Distributed surfaces that already exist:** peer cluster
  (`connectPeerClients`, `PeerRegistry`), `envoy-peer serve` CLI, `peers`
  tool, `peer/verify` + `PeerScoreboard` + `federatePeerScoreboard`,
  EnvoyMesh `listEnvoyHarnessPeers()` + in-process ACP `peers/list`.
- **What's missing:** a live renderer (panels, status bar, keymaps),
  cluster health/status beyond a static list, team-job progress, scoreboard
  views, discovery events, and any EnvoyMesh-specific dedicated panel.

## 3. Design principles

1. **Protocol first, UI second.** Every UI surface must be backed by an
   ACP/SDK method the harness (or host) serves. No UI-only state.
2. **Package 1 stays clean.** New protocol methods are additive optional
   seams on `ProtocolSessionBackend`; the TUI package consumes the
   client; the peer package may provide standalone wiring
   (`envoy-peer ui`); EnvoyMesh wires host state (peer pool, scoreboard).
3. **Hermetic + dependency-light.** The TUI renderer is a hand-rolled
   ANSI screen module (buffer-rendered, diffed) so tests run without a
   TTY and no TUI framework dependency is forced on the project.
4. **Distributed features are default-on surfaces, not hidden commands.**
   A cluster rail / status line is visible whenever the host reports
   peers; `/cluster`, `/team`, `/scoreboard` are detail views.
5. **Incremental rounds.** Each chunk ships protocol + tests + a visible
   UI increment; the design doc stays the contract.

## 4. Architecture

```
TUI (envoy-harness-tui)
  composer + transcript | status bar | rails/panels
  /cluster /team /scoreboard /peers ... | keymaps
        | EnvoyHarnessClient (ACP/SDK over stdio / in-process)
harness process (Package 1 --acp / --sdk)
  attachAcpServer / attachSdkServer
  ProtocolSessionBackend: prompt/cancel/tools/config
    + cluster/status, team/jobs, scoreboard/summary,
      discovery events (optional host-backed seams)
        | injected by the host
host state (EnvoyMesh node OR envoy-peer ui)
  peer pool (registry, health), team executor,
  scoreboard, federation
```

EnvoyGo/Tauri keep the Pi chat surface for in-flow chat; they can also
consume the same new protocol methods for dedicated panels later (Tauri
team coordinates, but the contract is set here).

## 5. Feature set

### 5.1 Everyday coding-agent power (v2 TUI)

- Composer with multi-line input, prompt history, `/` palette.
- Status bar: model, session id, running cost, cluster size, busy state.
- Transcript with roles + tool calls + plan steps + memory citations.
- Permission prompts inline (allow/deny with diff preview where cheap).
- `/plan` (existing REPL plan state), `/memories`, `/tools`, `/config`.
- Keymaps: Enter send, Esc cancel, arrows history, Tab completion of
  slash commands.

### 5.2 Distributed features (the differentiator)

- **Peer discovery:** live cluster rail - `id`, `model`, `capabilities`,
  health (last ping RTT), connected/failed counts. Config static
  discovery today; LAN/mDNS + mesh discovery events later (U3).
- **Cluster status (`/cluster`):** per-peer health, round-trip latency,
  routing preview ("a task with tag `research` would go to p-deepseek"),
  connect/disconnect.
- **Team jobs (`/team`):** live DAG of a running distributed team run -
  per-agent status, host (`local` vs `peer://id`), model, cost,
  verification state, artifacts.
- **Scoreboard (`/scoreboard`):** reputation per `(peer, skill)` from
  `PeerScoreboard`/verdicts; federation status (records pushed to the
  mesh arbitration store).
- **Observability:** event stream (tool calls, peer submits, verifies)
  rendered in a panel; trace/correlation ids shown per step.

## 6. Protocol additions (U1 - the contract)

Additive optional methods on `ProtocolSessionBackend` (ACP + SDK), each
with a client method and hermetic tests:

| Method | Returns | Source |
|---|---|---|
| `cluster/status` | peers with `health` (`ok`, `rttMs?`, `lastPingAt?`) + totals | host peer pool / registry |
| `team/jobs` | running/finished team jobs: agents, host, status, cost | host team executor |
| `scoreboard/summary` | `PeerReputation[]` (peer, skill, score, pass/fail counts) | `PeerScoreboard` |
| `discovery/events` (notify) | stream of peer discovered/lost/health-change events | host discovery layer |

Existing `peers/list` stays (flat list); `cluster/status` supersedes it
in the UI but `peers/list` remains the compatibility surface.

## 7. Chunk roadmap

| # | Chunk | Scope | Status |
|---|---|---|---|
| U1 | Protocol surface | `cluster/status`, `team/jobs`, `scoreboard/summary`, `discovery/events` on ACP+SDK + backend seams + client methods + fake-backend support; tests | ✅ |
| U2 | TUI renderer v2 | ANSI screen module (buffer + diff + regions), composer upgrade, status bar, cluster rail reading `cluster/status`; keymaps; hermetic render tests | ✅ |
| U3 | Distributed detail views | `/cluster`, `/team`, `/scoreboard` panels + discovery event stream; `envoy-peer ui` standalone wiring | ✅ |
| U4 | EnvoyMesh panels | desktop/EnvoyGo consume cluster/scoreboard via ACP host | ✅ |
| U5 | Polish | theming, search, diff view, images, session resume, trace/observability panel, memory/plan tabs | **partial** — U6a: tab strip + colored plan/memory/diff panels; images/resume picker deferred |

**Success criteria (v1):** a user on one machine can open the dedicated
TUI, see the cluster rail (peers + models + health), watch a team job
run across peers with per-agent status, read the scoreboard, and route a
sub-agent by model - all over the ACP/SDK contract, with Package 1
clean and both repos green.

## 8. Risks

| Risk | Mitigation |
|---|---|
| TUI framework creep | Hand-rolled ANSI screen module; renderer is buffer-tested, no TTY in CI |
| Protocol/UI drift | Every panel reads a protocol method; `cluster/status` test doubles as the contract |
| Standalone wiring (no EnvoyMesh) | `envoy-peer ui` (peer package) starts ACP server + registry + TUI in one process |
| Host state availability | All new methods are optional seams; UI shows "unavailable" when the host doesn't wire them |
| Recreating Pi/Codex UI wholesale | Borrow the good ideas (composer, rails), keep the surface small per round; distributed views are the moat, not pixel parity |
