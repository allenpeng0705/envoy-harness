# EHUI panel specification

> **Audience:** EnvoyGo / Tauri / desktop hosts building the envoy-harness
> side panel. Terminal hosts should use `envoy-harness-tui` (same contract).

This document is the consumer contract for **EHUI** (Envoy Harness UI) panels.
Package 1 (`@envoymesh/envoy-harness`) serves data over ACP JSON-RPC; hosts render
it. The TUI (`@envoymesh/envoy-harness-tui`) is the reference renderer.

See also: [envoy-harness-ui.md](./envoy-harness-ui.md), U6 plan
[implementation-plan-chunk-u6-product-shell.md](./implementation-plan-chunk-u6-product-shell.md).

## Panel catalog

| Panel id | Label | Primary wire | Notes |
|----------|-------|--------------|-------|
| `chat` | Chat | `session/prompt`, notifications | Composer + transcript; default view |
| `plan` | Plan | `session/plan` | Actions: `show`, `update`, `clear`, … |
| `memory` | Memory | `session/memory` | Ops: `list`, `read`, `add` |
| `git-diff` | Diff | `git/diff` | Options: `staged`, `stat` |
| `mesh` | Mesh | `cluster/status` | Summary + `/mesh` slash parity |
| `peers` | Peers | `peers/list` | Static + discovered peers |
| `cluster` | Cluster | `cluster/status`, `cluster/route` | Health rail + routing previews |
| `team` | Team | `team/jobs` | Distributed team job board |
| `scoreboard` | Scoreboard | `scoreboard/summary` | Peer × skill reputation |
| `trace` | Trace | `discovery/event` (notification) | Subscribe via `discovery/subscribe` |

The canonical list for TypeScript hosts is exported as `EHUI_PANELS` from
`@envoymesh/envoy-harness-client`.

## Session lifecycle

1. Spawn or attach to a harness ACP server (`envoy-harness --acp` or in-process).
2. `initialize` → `session/new` (or `session/load` for resume).
3. For each panel, call the mapped method with the active `sessionId`.
4. Subscribe to notifications for live surfaces:
   - `session/update`, `session/token`, `session/activity` — chat + tool progress
   - `discovery/event` — mesh trace ticker (after `discovery/subscribe`)
5. Permissions: handle server request `session/request_permission` (allow/deny).

## TypeScript client hooks

```typescript
import {
  spawnAcpServer,
  createEhuiDataSource,
  EHUI_PANELS,
  type EhuiPanelId,
} from "@envoymesh/envoy-harness-client";

const { client, close } = spawnAcpServer({ args: ["--acp"] });
await client.initialize();
const { sessionId } = await client.acpNewSession({ cwd: process.cwd() });

const ehui = createEhuiDataSource(client, sessionId);

// Plan panel
const planText = await ehui.plan("show");

// Diff panel
const diff = await ehui.gitDiff({ staged: false });

// Mesh rail
const cluster = await ehui.clusterStatus();

const unsub = await ehui.subscribeDiscovery((event) => {
  console.log(event.type, event.peerId);
});
```

`createEhuiDataSource` is intentionally thin — it does not cache or poll. Hosts
own refresh cadence (TUI re-fetches on view switch; React hosts use hooks).

## EnvoyGo integration (out of repo)

Recommended layout:

- **Pi chat surface** — existing `pi:proposal` + `session/update` (coding UX).
- **EHUI side panel** — `@envoymesh/envoy-harness-ehui` `EhuiShell` + tab strip
  (Plan | Memory | Diff | Mesh) beside Pi chat.
- **Data** — `@envoymesh/envoy-harness-client` `createEhuiDataSource` over stdio
  `--acp`, or `@envoymesh/envoy-harness-adapter` MAP bridge when embedded in EnvoyMesh.

Copy `EhuiShell` into EnvoyMesh `apps/social` beside `EnvoyHarnessPanel` or replace
the plain-text plan/diff sections as panels mature.

Panel bodies should mirror `envoy-harness-tui/src/view-resolver.ts` text layout
until a richer renderer lands in EnvoyGo.

## CLI entry

Standalone terminal users can run:

```bash
envoy-harness tui --spawn --provider openai --model gpt-4o
```

This delegates to `@envoymesh/envoy-harness-tui` with `--spawn` (live agent).

## Windows sandbox (F2a)

`sandbox_backend = "windows-sandbox"` and `--sandbox-executor windows-sandbox`
activate the F2a scaffold (`cmd.exe` + job-object lifecycle). FS isolation
(Codex `windows-sandbox-rs` pattern) is **F2b** — not required for EHUI hosts.

`envoy-harness doctor` reports `windows_sandbox` on win32.

## Versioning

Panel ids and method names are stable protocol surface. New panels add rows to
`EHUI_PANELS` without breaking hosts that ignore unknown ids.
