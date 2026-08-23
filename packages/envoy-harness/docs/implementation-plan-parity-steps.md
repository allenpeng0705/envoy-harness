# Codex / Claude Code parity — step-by-step plan

> Status: **done** (2026-08-23). Post–gap-closure polish from the parity review.

## Steps

| Step | Deliverable | Status |
|------|-------------|--------|
| **1** | `mcp_servers` in native TOML + codex import; `wireMcpClientsFromConfig`; CLI/ACP/REPL wire-up; `/mcp` lists live servers | ✅ |
| **2** | PTY `readOutput()` reflects live `onData` during `terminal_send` | ✅ |
| **3** | Codex `[[hook.*]]` import + `dsh-hooks-codex` deepseek bridge | ✅ |
| **4** | `envoy-harness doctor` health checks | ✅ |
| **5** | `/profile apply <name>` + action journal + `/undo` (write/edit) | ✅ |
| **6** | Docs drift, test consolidation | ✅ |
| **7** | U6 TUI: plan/memory/git-diff tabs, images, `/resume` + `session/load` | ✅ |
| **8** | MCP server mode: `envoy-harness mcp` stdio server | ✅ |
| **9** | Multimodal ACP: `image: true`, `content` blocks on `session/prompt` | ✅ |
| **10** | Exa + Perplexity search providers | ✅ |
| **11** | Cursor rules import (`.cursor/rules`) | ✅ |
| **12** | Cordis optional wire, mesh-remote transport stubs, Python SDK | ✅ |

## Notes

- **Mesh-remote** / **Cordis-compat**: Package 1 defines transport seams +
  optional `wireCordisFromConfig`; live mesh transports remain host-injected
  (adapter / EnvoyMesh).
- **Python SDK**: `packages/envoy-harness-python-sdk` — minimal stdio client;
  not published yet.
