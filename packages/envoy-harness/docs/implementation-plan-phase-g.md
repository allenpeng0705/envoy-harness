# Implementation plan — Phase G (item 12 dual-host + mesh seams)

> Status: **DONE** for scheduled Phase G scope (2026-08-22).
> **12a** TUI, **12b** Pi-surface + per-tool `pi:proposal`, **13/14b**
> adapter transport seams. Optional Cordis / 12c / mesh JobHandle only —
> see gap-closure **Intentional deferrals**.
> Social: Settings coding-backend toggle + Terminal → Chat (`PiChatPanel`).
> EnvoyGo push API unchanged (`pi:proposal` reuse). Optional EnvoyGo **Coding
> backend** control mirrors Social (same `piSettings.codingBackend`); old
> EnvoyGo builds stay compatible without that control.

## Product decision (2026-08-22)

**A first:** terminal TUI in this monorepo + EnvoyMesh Tauri later.  
**B later (optional):** an extra desktop/web host in this monorepo — not scheduled.

Both rich hosts consume ACP/SDK only. Package 1 stays UI-free (REPL stopgap OK).

## 12a — Terminal TUI (this repo)

**Package:** `packages/envoy-harness-tui` (`@envoymesh/envoy-harness-tui`)

| Chunk | Deliverable | Status |
|-------|-------------|--------|
| G1 | Package skeleton + stdio ACP attach via `@envoymesh/envoy-harness-client` | ✅ |
| G2 | Transcript (committed `session/update` only) + composer + cancel | ✅ |
| G3 | Approval surface (`session/request_permission`) + slash palette stub | ✅ |
| G4 | Bin entry `envoy-harness-tui` + hermetic tests | ✅ |
| G5 | Live attach: Package 1 `envoy-harness --acp` + TUI `--spawn` / pipe attach | ✅ |

**Shipped:** readline+ANSI MVP (no Ink); in-process demo **and** live
`envoy-harness --acp` stdio (see G5). Client helper: `spawnAcpServer`.

**G5 note:** bare `envoy-harness --acp` uses the hermetic demo backend
unless `--provider <name>` is set or `RunOptions.model` is injected
(live Agent + `BUILTIN_TOOLS` + per-tool `session/request_permission`).
Cancel on the live Agent path calls `agent.abort()`.

**Stack lean:** plain `readline`+ANSI MVP — do not pull Tauri/Electron into this package.

**Tests:** hermetic fake ACP pair + CLI `--acp` pipe tests + TUI attached-pipe test.

## 12b — EnvoyMesh Tauri (EnvoyMesh repo)

**Contract (this repo):** [`tauri-acp-host.md`](./tauri-acp-host.md).

**EnvoyMesh host layer:** `apps/node/src/agent-runtime-envoy/acp-host.ts`
(`createEnvoyHarnessAcpHost`), Pi `codingBackend` routing, `pi:proposal` bridge
for ACP permissions, Social Settings + Terminal Chat remount of `PiChatPanel`.

**Per-tool approvals:** `runtime.ask({ askHandler })` +
`shouldAskAcpTool(autoRunPolicy)` — `off` auto-allows, `safe-only` skips
safe tools (`read_file` / `git` / …), `always-confirm` asks every tool via
`session/request_permission` → `pi:proposal`.

## 12c — Future extra host (optional)

Desktop/web GUI in this monorepo only if a concrete consumer appears.
Reuse the same client; do not fork protocol.

## Other Phase G items

- ✅ **13 / 14b adapter seams** — `createMeshCredentialsProvider` +
  `loadRemoteSession` in `@envoymesh/envoy-harness-adapter` (host injects
  live mesh transport; Package 1 stubs unchanged).
- Optional: Cordis-compat container, mesh-remote `JobHandle` — see
  gap-closure Intentional deferrals.

## Out of scope for 12a

- Token streaming in the transcript (committed messages only)
- Embedding EnvoyMesh or Tauri in Package 1
- Replacing the REPL (REPL remains the zero-dep fallback)
