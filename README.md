# envoy-harness

Home-team agent harness for everyday coding — **CLI**, **browser WebUI**, and
optional **multi-machine peers**. Works on a laptop with **no EnvoyMesh**.

| You want… | Do this |
|---|---|
| Chat in the browser | [`envoy-harness web`](#how-to-use-the-webui) |
| Interactive terminal | [`envoy-harness --repl`](#how-to-use-the-cli) |
| One prompt, then exit | [`envoy-harness "…"`](#one-shot) |
| Several machines on LAN/WAN | [`Distributed peers`](#distributed-features-no-envoymesh-required) |

**Status:** Rounds 1–8 shipped. Plan:
[`packages/envoy-harness/docs/implementation-plan.md`](./packages/envoy-harness/docs/implementation-plan.md).

---

## Contents

1. [Quick start](#quick-start)
2. [Packages](#packages)
3. [CLI](#how-to-use-the-cli)
4. [WebUI](#how-to-use-the-webui)
5. [Distributed features](#distributed-features-no-envoymesh-required)
6. [Monorepo commands](#monorepo-commands)
7. [Docs](#docs)

---

## Quick start

```sh
pnpm install

# Pick one API key (+ optional compatible base URL):
export OPENAI_API_KEY=…        # or ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / …
# export OPENAI_BASE_URL=https://your-compatible-gateway/v1   # LiteLLM, Azure, local proxy, …

# A) Browser WebUI (recommended GUI)
pnpm --filter @envoymesh/envoy-harness-web start -- \
  --provider openai --model gpt-4o --persist
# open http://127.0.0.1:5177/  → Settings for provider / model / base URL

# B) Terminal REPL (recommended for long sessions)
pnpm envoy -- --repl --provider openai --model gpt-4o

# C) One-shot (explicit --base-url also works)
pnpm envoy -- --provider openai --model gpt-4o "explain this repo"
# pnpm envoy -- --provider openai --model my-model \
#   --base-url https://your-compatible-gateway/v1 "hello"
```

After install/build, the binary name is **`envoy-harness`**. In this monorepo,
`pnpm envoy -- …` forwards to it.

---

## Packages

| Package | Role |
|---|---|
| [`@envoymesh/envoy-harness`](./packages/envoy-harness/README.md) | Core agent + CLI |
| [`@envoymesh/envoy-harness-web`](./packages/envoy-harness-web/README.md) | Browser WebUI |
| [`@envoymesh/envoy-harness-peer`](./packages/envoy-harness-peer/README.md) | TCP peers (`envoy-peer serve`) — no EnvoyMesh |
| [`@envoymesh/envoy-harness-tui`](./packages/envoy-harness-tui/README.md) | Terminal UI over ACP |
| [`@envoymesh/envoy-harness-ehui`](./packages/envoy-harness-ehui/README.md) | React EHUI side panels |
| [`@envoymesh/envoy-harness-client`](./packages/envoy-harness-client/README.md) | Typed ACP client |
| [`@envoymesh/envoy-harness-adapter`](./packages/envoy-harness-adapter/README.md) | Optional EnvoyMesh bridge |

Package 1 stays **EnvoyMesh-free**. Peers are a separate package; EnvoyMesh is optional.

---

## How to use the CLI

### Modes

| Mode | Command | Best for |
|---|---|---|
| One-shot | `envoy-harness "prompt"` | Single task |
| REPL | `envoy-harness --repl` | Hours of interactive work |
| WebUI | `envoy-harness web` | Browser daily driver |
| TUI | `envoy-harness tui` | Terminal ACP UI |
| ACP | `envoy-harness --acp` | Hosts (WebUI/TUI spawn this) |
| Team | `envoy-harness team team.toml` | Scripted multi-agent runs |

### One-shot

```sh
envoy-harness --provider openai --model gpt-4o "summarize README.md"

envoy-harness --sandbox workspace-write --approval on-request \
  "refactor src/auth.ts and add tests"

envoy-harness --plan "add a /healthz endpoint"

envoy-harness --persist "fix the flaky test"    # prints session id on stderr
envoy-harness --resume <session-id> "continue from there"

# Caps (defaults: 50 turns, $5.00)
envoy-harness --max-turns 80 --max-cost-usd 2.5 "…"
```

### REPL (long-run)

```sh
envoy-harness --repl --provider openai --model gpt-4o --sandbox workspace-write
```

On a real terminal (TTY), the REPL **auto-saves** the session:

```text
auto-persisted session: <id> (use --resume <id>)
```

| | One-shot | REPL |
|---|---|---|
| Max turns | 50 | **200** |
| Cost limit | **$5** | none (unless you set `--max-cost-usd`) |
| Save session | `--persist` | **auto on TTY** |

Handy slash commands:

| Command | Purpose |
|---|---|
| `/help` | List commands |
| `/model` `/provider` | Switch model |
| `/sandbox` `/approval` | Permissions |
| `/preset safe` \| `ask-all` \| `approve-all` | One-knob policy |
| `/agents` | Local sub-agents from `task` |
| `/status` `/cost` | Session state |
| `/quit` | Exit |

Resume later:

```sh
envoy-harness --repl --resume <session-id>
```

### Local parallel sub-agents

**On by default** for one-shot, REPL, ACP, and WebUI. The model can call
`task`; several tasks in one turn run in parallel (capped).

```sh
envoy-harness --no-subagents "…"          # opt out
envoy-harness --repl --no-subagents
envoy-harness web --no-subagents
```

### Useful flags

| Flag | Meaning |
|---|---|
| `--provider` / `--model` | Which LLM |
| `--base-url` | Override API base (OpenAI-/Anthropic-compatible gateways) |
| `--sandbox` | `read-only` · `workspace-write` · `danger-full-access` |
| `--approval` | `unless-trusted` · `on-request` · `granular` · `never` |
| `--cwd` | Tool working directory |
| `--max-turns` / `--max-cost-usd` | Stop conditions |
| `--persist` / `--resume` / `--fork` | Session save / load / branch |
| `--no-subagents` | Disable default local `task` |
| `--peers id@host:port` | Connect standalone peers (repeatable) |
| `--discovery static\|mdns\|none` | Peer discovery mode |
| `--json` / `--verbose` / `--quiet` | Output style |

**API keys (env):** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, …
**Base URLs (env or `--base-url`):** `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `DEEPSEEK_BASE_URL`, … — any OpenAI- or Anthropic-compatible endpoint.
**Config file:** `~/.config/envoy-harness/config.toml` or `ENVOY_HARNESS_CONFIG`.

**Project config is untrusted by default.** A repo-committed
`.envoy/config.toml` is read, but security-relevant keys
(`permissionMode`, `askForApproval`, `sandboxBackend`, `hooks`,
`mcpServers`, `plugins`, `peers`, `persona`, …) are **ignored with a
warning** — a repository must not be able to lift your sandbox or run its
own commands just because you opened it. To trust a specific checkout,
add its absolute path to
`~/.local/state/envoy-harness/trusted-projects.json`.

More detail: [`packages/envoy-harness/QUICKSTART.md`](./packages/envoy-harness/QUICKSTART.md).

---

## How to use the WebUI

The WebUI is the **primary browser entry**: chat, permissions, settings,
mesh status, and EHUI panels. It talks ACP over WebSocket to a local
`envoy-harness --acp` process.

### Start

```sh
# Monorepo
pnpm --filter @envoymesh/envoy-harness-web start -- \
  --provider openai --model gpt-4o --persist

# Same thing via CLI
envoy-harness web --provider openai --model gpt-4o --persist
```

Open **http://127.0.0.1:5177/** (default).

| Flag | Meaning |
|---|---|
| `--port` / `--host` | Bind address (default `127.0.0.1:5177`) |
| `--cwd` | Working directory for tools |
| `--provider` / `--model` | Passed to the ACP child |
| `--base-url` | Passed to the ACP child (compatible gateway) |
| `--persist` | Save sessions for resume |
| `--peers id@host:port` | Wire TCP peers |
| `--no-subagents` | Disable local `task` |
| `--no-open` | Do not auto-open a browser tab |
| `--dev` | Force Vite middleware mode |

### In the UI

| Area | Use it for |
|---|---|
| Chat + Cancel | Talk to the agent; abort a turn |
| Permission / question modals | Approve tools; answer asks |
| Settings | Provider, model, base URL, sandbox, approval, auto-run, theme |
| Connection control | Reconnect if the ACP process drops |
| Mesh rail | Peers, jobs, local/remote agents |
| EHUI dock | Plan · Diff · Mesh · Peers · Team · Scoreboard · Trace · Resume |

Keys stay on the **Node machine** (env / config), not in the browser.

Package docs: [`packages/envoy-harness-web/README.md`](./packages/envoy-harness-web/README.md).

---

## Distributed features (no EnvoyMesh required)

You can run **several machines** that collaborate over plain **TCP**
(LAN or public IP). EnvoyMesh is an optional upgrade, not a requirement.

```text
LocalMeshSubmitter  →  PeerMeshSubmitter  →  RemoteMeshSubmitter
   this laptop            TCP --peers          EnvoyMesh (optional)
```

### Step 0 — Discover peers automatically (optional)

mDNS/DNS-SD is implemented (`_envoy-harness._tcp.local`), so two machines
on the same LAN can find each other with **no `--peers` config**:

```sh
# Machine A — serve AND advertise on the LAN
envoy-peer serve --port 8123 --peer-id alice --model deepseek-chat --advertise

# Machine B — browse instead of listing peers
envoy-harness --repl --discovery mdns --provider openai --model gpt-4o
```

`--advertise` publishes PTR/SRV/TXT/A records carrying the peer id, model
and capabilities, so the orchestrator can route by model. Discovery is
**fail-open**: a machine with multicast blocked (CI, hardened sandbox,
corporate WLAN) logs a warning and runs normally with whatever static
`--peers` you configured.

### Step 1 — Start a worker peer

On machine A (or another terminal on the same host):

```sh
pnpm --filter @envoymesh/envoy-harness-peer exec \
  tsx bin/envoy-peer.ts serve \
  --port 8123 \
  --peer-id alice \
  --model deepseek-chat
```

- Listens on `0.0.0.0:8123` by default (reachable on the LAN if the firewall allows it).
- Built-in demo adapter is fine for smoke tests; production should pass `--adapter <module>`.

See [`packages/envoy-harness-peer/README.md`](./packages/envoy-harness-peer/README.md).

### Step 2 — Connect from CLI or WebUI

**Same LAN:**

```sh
envoy-harness --repl --peers alice@192.168.1.20:8123 \
  --provider openai --model gpt-4o

envoy-harness web --persist --peers alice@192.168.1.20:8123 \
  --provider openai --model gpt-4o
```

**WAN / public IP:**

```sh
envoy-harness web --persist --peers alice@203.0.113.10:8123
```

**Several peers:**

```sh
envoy-harness --repl \
  --peers alice@192.168.1.20:8123 \
  --peers bob@192.168.1.21:8123
```

Or set `ENVOY_PEERS=alice@192.168.1.20:8123,bob@192.168.1.21:8123`.

### Step 3 — Watch status

- **WebUI:** Mesh rail + EHUI tabs (Mesh, Peers, Team, Scoreboard, Trace)
- **ACP / TUI:** `peers/list`, `cluster/status`, `team/jobs`
- **REPL:** `/agents` for local `task` sub-agents

### WAN checklist

1. Peer port open on the firewall / security group  
2. If behind NAT: port-forward, public IP, or a tunnel (Tailscale, SSH)  
3. Treat the peer port as private (v1 auth is lightweight)

### Standalone peers vs EnvoyMesh

| | `--peers` (standalone) | EnvoyMesh |
|---|---|---|
| Transport | TCP + JSON-RPC | libp2p + signed envelopes |
| Setup | `envoy-peer serve` + `--peers` | Mesh + adapter package |
| Enough for LAN/WAN coding? | **Yes** | Optional for richer fabric |

Design notes: [`packages/envoy-harness/docs/distributed-collaboration.md`](./packages/envoy-harness/docs/distributed-collaboration.md).

---

## Monorepo commands

```sh
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run envoy -- --help

pnpm --filter @envoymesh/envoy-harness-web start
pnpm --filter @envoymesh/envoy-harness-web test
```

---

## Docs

| Doc | What |
|---|---|
| [`packages/envoy-harness/QUICKSTART.md`](./packages/envoy-harness/QUICKSTART.md) | Operator quickstart |
| [`packages/envoy-harness/docs/design.en.md`](./packages/envoy-harness/docs/design.en.md) | Design |
| [`packages/envoy-harness/docs/implementation-plan.md`](./packages/envoy-harness/docs/implementation-plan.md) | What shipped |
| [`packages/envoy-harness/docs/envoy-harness-ui.md`](./packages/envoy-harness/docs/envoy-harness-ui.md) | UI / EHUI |

## License

Apache-2.0
