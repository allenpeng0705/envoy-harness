# `@envoymesh/envoy-harness-web`

**Browser WebUI** for `envoy-harness` — the primary GUI entry.

Chat, permissions, model/policy settings, session resume, mesh status, and
EHUI panels over ACP WebSocket. **EnvoyMesh is not required.**

→ Full monorepo guide: [root README](../../README.md#how-to-use-the-webui)

---

## Start

```sh
# Monorepo (recommended while developing)
pnpm --filter @envoymesh/envoy-harness-web start -- \
  --provider openai --model gpt-4o --persist

# Same via Package 1
envoy-harness web --provider openai --model gpt-4o --persist

# Don’t open a browser tab; use Vite middleware mode
envoy-harness web --dev --no-open --port 5177
```

Then open **http://127.0.0.1:5177/**

Each browser tab opens `/ws/acp`; the Node bridge spawns one
`envoy-harness --acp` child process.

### Flags

| Flag | Meaning |
|---|---|
| `--port <n>` | HTTP port (default `5177`) |
| `--host <addr>` | Bind address (default `127.0.0.1`) |
| `--cwd <path>` | Working directory for tools |
| `--provider` / `--model` | Forwarded to `--acp` |
| `--base-url <url>` | Forwarded to `--acp` (OpenAI-/Anthropic-compatible) |
| `--persist` | Persist sessions (resume in Settings / EHUI) |
| `--no-subagents` | Disable default local parallel `task` |
| `--peers id@host:port` | Standalone TCP peers (repeatable) |
| `--dev` | Force Vite middleware mode |
| `--no-open` | Do not open a browser tab |

Put API keys in the **shell env** or config.toml on the Node host — never
in browser storage. Optional `OPENAI_BASE_URL` / `--base-url` / Settings →
Base URL routes `openai`/`anthropic` to compatible gateways.

---

## Using the UI

Three-column shell (inspired by deepseek-harness, Envoy branding):

| Area | Purpose |
|---|---|
| **Left · Sessions** | New session, resume list, connection pill, Settings |
| **Center · Chat** | Empty hero, markdown streaming, foldable activity, Stop/Send |
| **Right · Details** | **Mesh** tab (peers/jobs) · **Tools** tab (Plan/Diff/Memory/…) |
| **Permissions** | Summary of command/path; expandable raw args |
| **Settings** | Provider, model, base URL, policy, light/dark theme |
| **Connection** | Connecting / connected / disconnected; Reconnect |

**Long runs:** start with `--persist`, use **Stop** when needed, and Reconnect
if the ACP child dies (auto-backoff + manual button). Resume hydrates the
transcript from `session/load`. While the agent is busy, **Enter** / **Queue**
enqueues the next message. Fonts use system stacks (no CDN — works offline).

**Parallel sub-agents:** on by default. Ask the model to use `task`; watch
the Mesh tab. Opt out with `--no-subagents`.

---

## Distributed peers (LAN / WAN)

```sh
# Machine A — worker
pnpm --filter @envoymesh/envoy-harness-peer exec \
  tsx bin/envoy-peer.ts serve --port 8123 --peer-id alice

# Machine B — this WebUI
envoy-harness web --persist --peers alice@192.168.1.20:8123 \
  --provider openai --model gpt-4o
```

Use a public IP the same way for WAN. Open the **Mesh** details tab (and
Tools → Team / Trace) to inspect the cluster.

Details: [root README — Distributed](../../README.md#distributed-features-no-envoymesh-required) ·
[`envoy-harness-peer` README](../envoy-harness-peer/README.md).

---

## Develop

```sh
pnpm --filter @envoymesh/envoy-harness-web test
pnpm --filter @envoymesh/envoy-harness-web typecheck
pnpm --filter @envoymesh/envoy-harness-web build
```

```text
Browser  --JSON-RPC / WebSocket-->  Node bridge  --stdio ACP-->  envoy-harness --acp
```

## License

Apache-2.0
