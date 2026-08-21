# 12b — EnvoyMesh Tauri as ACP/SDK host

> Status: **done** (2026-08-22) via **Pi surface reuse**.
> Package 1 stays UI-free. EnvoyGo needs **no** app update.

## Constraints

1. Simple UI — no new Social nav / docks; reuse Pi chat + `pi:proposal`.
2. EnvoyGo unchanged — same RPCs/events (`sendToPi`, `piRespondToProposal`,
   `pi:proposal`, push `pi_proposal`).

## How it works

| Knob | Effect |
|------|--------|
| `piSettings.codingBackend: "pi"` | Default — Pi sidecar |
| `piSettings.codingBackend: "envoy-harness"` | `sendToPi` → ACP + envoy-harness; permissions → `pi:proposal` |
| `piSettings.autoRunPolicy: "off"` | Skip confirm before EH ask |
| Terminal → **Chat** | Existing `PiChatPanel` (Allow/Deny dock) |
| Pi TUI (`ensurePiTerminalSession`) | Remains Pi-only |

## Host options (Package 1)

Still available for spawn / TUI / hermetic tests:

- `envoy-harness --acp` / `cli/acp-stdio.js`
- `createEnvoyHarnessAcpHost` / `spawnAcpServer`

## Verification

- EnvoyMesh: `apps/node/test/pi-coding-backend.test.ts`, `node-service-acp-ui.test.ts`,
  `agent-runtime-envoy-acp-host.test.ts`
- Manual: Settings → AI → Coding backend = envoy-harness → Terminal → Chat → prompt
