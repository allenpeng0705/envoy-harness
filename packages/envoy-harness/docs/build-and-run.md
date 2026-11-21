# Build and run — CLI + WebUI

Operator guide for developing and running **envoy-harness** from this monorepo
(or from an installed package). Covers prerequisites, workspace build, the
CLI binary, and the browser WebUI.

| Short path | Command |
|---|---|
| Fresh clone | `pnpm install && pnpm run build` |
| CLI REPL | `pnpm envoy -- --repl --provider … --model …` |
| WebUI | `pnpm envoy -- web --provider … --model … --persist` |
| Same WebUI | `pnpm --filter @envoymesh/envoy-harness-web start -- …` |
| Help | `pnpm envoy -- --help` |

Related: [root README](../../../README.md) · [QUICKSTART](../QUICKSTART.md) ·
[web package README](../../envoy-harness-web/README.md).

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js ≥ 22.19** | See root `package.json` `engines` |
| **pnpm 10** | Repo pins `"packageManager": "pnpm@10.0.0"` |
| **API key** | At least one of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, … |
| **Optional base URL** | `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` / `DEEPSEEK_BASE_URL` or CLI `--base-url` for compatible gateways |

Keys and base URLs live on the **Node host** (shell env or TOML config), never
in browser storage.

```sh
export OPENAI_API_KEY=…
# export OPENAI_BASE_URL=https://your-compatible-gateway/v1
```

Default user config (optional): `~/.config/envoy-harness/config.toml`
(override with `ENVOY_HARNESS_CONFIG` or `--config`).

---

## 2. Monorepo layout (what you are building)

```text
envoy-harness/                          # monorepo root
  package.json                          # pnpm run build | envoy | verify
  scripts/build-workspace.mjs           # ordered workspace build
  packages/
    envoy-harness/                      # core agent + CLI  → binary envoy-harness
    envoy-harness-web/                  # browser host      → envoy-harness web
    envoy-harness-client/               # typed ACP client
    envoy-harness-ehui/                 # React EHUI panels
    envoy-harness-tui/                  # terminal UI
    envoy-harness-peer/                 # TCP peers (optional)
    …
```

**Binary names**

| Name | Role |
|---|---|
| `envoy-harness` | Package 1 CLI (`bin/envoy-harness.ts` → `tsx` from source) |
| `envoy-harness-web` | Web package bin (built `dist/server/bin.js`, or `tsx` via `start`) |
| `pnpm envoy -- …` | Monorepo shorthand → `pnpm --filter @envoymesh/envoy-harness run envoy` |

There is no separate `envoy` binary; examples that say `envoy-harness` are the
canonical form. In the monorepo prefer `pnpm envoy -- …`.

---

## 3. Build

### Fresh clone (required)

Workspace packages resolve TypeScript declarations through each package’s
`exports` → `dist/*.d.ts`. On a clean tree those files do not exist yet, so
you must build **before** typecheck, most tests, or running dependents.

```sh
cd /path/to/envoy-harness
pnpm install
pnpm run build
```

`pnpm run build` runs `scripts/build-workspace.mjs`, which:

1. Scans each package’s `src/**` for `@envoymesh/*` imports
2. Topologically sorts packages (cycle = hard error)
3. Builds **one dependency level at a time** (parallel within a level)

Do **not** rely on plain `pnpm -r run build` for a clean checkout — pnpm does
not wait for dependency builds, so dependents can start too early and fail
with `TS2307: Cannot find module`.

Useful:

```sh
pnpm run build:graph    # print derived order without building
pnpm run clean          # rm dist/ in all packages
pnpm run verify         # build + typecheck + test (CI-shaped)
```

### What each package’s `build` does

| Package | `build` script (approx.) |
|---|---|
| `@envoymesh/envoy-harness` | `tsc -p tsconfig.build.json` → `dist/` |
| `@envoymesh/envoy-harness-web` | `tsc` (server) **+** `vite build` (client) → `dist/server`, `dist/client` |
| Others | Usually `tsc` → `dist/` |

### When to rebuild

| Change | Action |
|---|---|
| Fresh clone / after `clean` | `pnpm run build` |
| Edited Package 1 / shared libs | Rebuild (or `pnpm run build`) before dependents that import `dist` |
| Edited WebUI React only | `pnpm --filter @envoymesh/envoy-harness-web start -- --dev` often enough (Vite); rebuild client for static `dist/client` |
| Before PR / CI parity | `pnpm run verify` |

---

## 4. Run the CLI

### Entry points

```sh
# Monorepo (source via tsx) — preferred while developing
pnpm envoy -- --help
pnpm envoy -- --version

# After global install
npm install -g @envoymesh/envoy-harness   # or pnpm add -g …
envoy-harness --help
```

### Modes

| Mode | Command | Notes |
|---|---|---|
| **One-shot** | `pnpm envoy -- [flags] "prompt"` | Default; exits when the turn ends |
| **REPL** | `pnpm envoy -- --repl [flags]` | Long session; 26 slash commands; auto-persist on TTY |
| **ACP** | `pnpm envoy -- --acp [flags]` | JSON-RPC on stdio; WebUI/TUI spawn this |
| **WebUI** | `pnpm envoy -- web [flags]` | Delegates to `@envoymesh/envoy-harness-web` |
| **TUI** | `pnpm envoy -- tui [flags]` | Terminal ACP host |
| **Team** | `pnpm envoy -- team team.toml` | Sequential multi-agent TOML |
| **Doctor** | `pnpm envoy -- doctor` | Health checks |
| **Self-evolve** | `pnpm envoy -- self-evolve` | Shadow cycle by default |

### One-shot examples

```sh
pnpm envoy -- --provider openai --model gpt-4o "explain this repo"

pnpm envoy -- --sandbox workspace-write --approval on-request \
  "refactor src/auth.ts and add tests"

pnpm envoy -- --plan "add a /healthz endpoint"

pnpm envoy -- --persist "fix the flaky test"    # session id on stderr
pnpm envoy -- --resume <session-id> "continue"

# Caps (defaults: 50 turns, $5.00 one-shot)
pnpm envoy -- --max-turns 80 --max-cost-usd 2.5 "…"

# Compatible gateway
pnpm envoy -- --provider openai --model my-model \
  --base-url https://your-compatible-gateway/v1 "hello"

# Stdin prompt
echo "summarize the diff" | pnpm envoy -- -
```

### REPL examples

```sh
pnpm envoy -- --repl --provider openai --model gpt-4o --sandbox workspace-write
```

On a real TTY the REPL **auto-saves** and prints:

```text
auto-persisted session: <id> (use --resume <id>)
```

| | One-shot | REPL |
|---|---|---|
| Max turns | 50 | **200** |
| Cost limit | **$5** | uncapped unless `--max-cost-usd` |
| Persist | `--persist` | **auto on TTY** |

```text
envoy> /help
envoy> /model gpt-4o
envoy> /preset safe
envoy> /preset mobile    # Flutter / RN / native + device_*
envoy> /preset webdev    # Vite / Next / SPA + browser_*
envoy> /agents
envoy> /quit
```

Resume:

```sh
pnpm envoy -- --repl --resume <session-id>
```

### Permission presets

One knob expands sandbox + approval + auto-run (and domain roots):

| Preset | Sandbox | Approval | Auto-run | Extra |
|---|---|---|---|---|
| `safe` | read-only | unless-trusted | always-confirm | — |
| `ask-all` | workspace-write | on-request | always-confirm | — |
| `approve-all` | danger-full-access | never | off | — |
| `mobile` | workspace-write | on-request | safe-only | network + Simulator/SDK roots → `device_*` |
| `webdev` | workspace-write | on-request | safe-only | network + Vite/Next/Playwright caches → `browser_*` |

```sh
pnpm envoy -- --permission-preset mobile --repl …
pnpm envoy -- --permission-preset webdev --repl …
```

Details: [`mobile.md`](./mobile.md), [`webdev.md`](./webdev.md). ACP/SDK:
`session/set_policy` with `{ "preset": "mobile" | "webdev" | … }`.

### Useful shared flags

| Flag | Meaning |
|---|---|
| `--provider` / `--model` | LLM |
| `--base-url` | Compatible API base |
| `--permission-preset` | `safe` · `ask-all` · `approve-all` · `mobile` · `webdev` |
| `--sandbox` | `read-only` · `workspace-write` · `danger-full-access` |
| `--approval` | `unless-trusted` · `on-request` · `granular` · `never` |
| `--cwd` | Tool working directory |
| `--persist` / `--resume` / `--fork` | Session save / load / branch |
| `--session-dir` | Default `~/.local/state/envoy-harness/sessions` |
| `--no-subagents` | Disable default local `task` |
| `--peers id@host:port` | Standalone TCP peers (repeatable) |
| `--json` / `--verbose` / `--quiet` | Output style |

Authoritative flag list: `pnpm envoy -- --help` (also `src/cli/argv-help.ts`).

### Local sub-agents

**On by default** for one-shot, REPL, ACP, and WebUI. Opt out:

```sh
pnpm envoy -- --no-subagents "…"
pnpm envoy -- --repl --no-subagents
pnpm envoy -- web --no-subagents
```

---

## 5. Run the WebUI

### Architecture

```text
Browser  --JSON-RPC / WebSocket /ws/acp-->  Node bridge (envoy-harness-web)
                                              |
                                              +--stdio ACP-->  envoy-harness --acp
```

- Default URL: **http://127.0.0.1:5177/**
- Health: `GET /api/health`
- Each browser tab gets a WebSocket; the bridge spawns (or attaches) an ACP child
- UI: session tabs, nested split panes, permissions, Settings, Mesh / EHUI panels

### Start (three equivalent ways)

After `pnpm install && pnpm run build`:

```sh
# A) Package script (tsx on server source; Vite middleware if client dist missing)
pnpm --filter @envoymesh/envoy-harness-web start -- \
  --provider openai --model gpt-4o --persist

# B) CLI subcommand (resolves sibling web package or installed bin)
pnpm envoy -- web --provider openai --model gpt-4o --persist

# C) Installed / linked binary
envoy-harness web --provider openai --model gpt-4o --persist
```

Open **http://127.0.0.1:5177/** (auto-open is on unless `--no-open`).

### Dev vs static client

| Mode | When | How |
|---|---|---|
| **Vite middleware (`--dev`)** | Developing React UI; or `dist/client/index.html` missing | `… start -- --dev` or `… web --dev` |
| **Static `dist/client`** | After `pnpm --filter @envoymesh/envoy-harness-web build` | Default when `dist/client/index.html` exists and `--dev` not set |

```sh
# Force HMR even if client dist exists
pnpm --filter @envoymesh/envoy-harness-web start -- --dev --no-open --port 5177

# Production-shaped static assets
pnpm --filter @envoymesh/envoy-harness-web build
pnpm --filter @envoymesh/envoy-harness-web start -- --provider openai --model gpt-4o
```

### WebUI flags

| Flag | Meaning | Default |
|---|---|---|
| `--port <n>` | HTTP port | `5177` |
| `--host <addr>` | Bind address | `127.0.0.1` |
| `--cwd <path>` | Working directory for ACP tools | process cwd |
| `--provider` / `--model` | Forwarded to `--acp` | — |
| `--base-url <url>` | Forwarded to `--acp` | — |
| `--persist` | Persist sessions for resume | off |
| `--no-subagents` | Disable local `task` | off |
| `--peers id@host:port` | TCP peers (repeatable) | — |
| `--config-patch` / `--profile` | Forwarded to `--acp` | — |
| `--dev` | Force Vite middleware | auto if no client dist |
| `--no-open` | Do not open a browser tab | open on |

```sh
pnpm envoy -- web --help
# or
pnpm --filter @envoymesh/envoy-harness-web start -- --help
```

### In the UI (operator checklist)

1. Set **Settings → Model** (provider / model / base URL) if not passed on the CLI
2. Prefer **`--persist`** for long runs; use **Stop** / **Reconnect** if ACP drops
3. **Open project…** adds workspaces under `~/.config/envoy-harness/workspaces.json`
4. Session **tabs** + **Split | / Split —** for nested multi-pane chats
5. Mesh / Details rails for peers, files, preview, schedule, goals

---

## 6. Test and typecheck

```sh
# Whole monorepo (after build)
pnpm run typecheck
pnpm run test
pnpm run verify          # build + typecheck + test

# Package-scoped
pnpm --filter @envoymesh/envoy-harness test
pnpm --filter @envoymesh/envoy-harness-web test
pnpm --filter @envoymesh/envoy-harness-web typecheck
```

Live LLM tests (Package 1, opt-in): `pnpm --filter @envoymesh/envoy-harness test:live`
with `RUN_LIVE_TESTS=1`.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `TS2307: Cannot find module '@envoymesh/…'` | Missing / stale `dist/` | `pnpm run build` |
| `pnpm -r run build` fails on clean tree | Unordered recursive build | Use `pnpm run build` |
| WebUI starts but chat never connects | ACP child missing key / crashed | Check terminal for `--acp` errors; set API key; Reconnect in UI |
| `envoy-harness web` / “web not found” | Web package not installed / not built | Monorepo: use `pnpm envoy -- web` after build; or install `@envoymesh/envoy-harness-web` |
| Port in use | Something on `5177` | `--port 5178` |
| Blank UI after build | Stale client | Rebuild web package or pass `--dev` |
| Provider auth errors | Wrong key / base URL | Env vars or Settings; `--base-url` for gateways |

Inspect build order without compiling:

```sh
pnpm run build:graph
```

---

## 8. Copy-paste recipes

### Daily CLI

```sh
pnpm install && pnpm run build   # once
export OPENAI_API_KEY=…
pnpm envoy -- --repl --provider openai --model gpt-4o --sandbox workspace-write
```

### Daily WebUI

```sh
pnpm install && pnpm run build   # once
export OPENAI_API_KEY=…
pnpm envoy -- web --provider openai --model gpt-4o --persist
# → http://127.0.0.1:5177/
```

### WebUI + Vite HMR

```sh
pnpm --filter @envoymesh/envoy-harness-web start -- \
  --dev --no-open --provider openai --model gpt-4o --persist
```

### One-shot CI-style verify

```sh
pnpm run verify
```
