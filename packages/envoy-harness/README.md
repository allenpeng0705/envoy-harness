# @envoymesh/envoy-harness

> **Status:** Phases 0–7 + **Round 8** (standalone CLI power, default local
> sub-agents, long-run REPL, browser WebUI). Works **without EnvoyMesh** —
> `npm install` / monorepo use on a stock laptop. Optional TCP peers and
> EnvoyMesh are add-ons, not requirements.

Production-grade agent harness with four design targets:

- **Independently runnable** — no mesh, peer, or EnvoyMesh install required.
- **EnvoyMesh-ready** — same MAP contracts when you opt into the mesh adapter.
- **Easy to integrate** — depend on the package and adapt against `@envoymesh/protocol`.
- **Hermetic tests** — suite passes with no network and no live LLM key.

**User guides:** monorepo [`README.md`](../../README.md) (CLI · WebUI · peers) ·
[`QUICKSTART.md`](./QUICKSTART.md) ·
[`../envoy-harness-web/README.md`](../envoy-harness-web/README.md).

## What ships

### Core agent

| Capability | Status | Where |
|---|---|---|
| Agent loop + CLI | ✅ shipped | `src/agent.ts`, `src/cli/run.ts` |
| Permission modes (read-only / workspace-write / danger-full-access) + per-call approval | ✅ shipped | `src/permissions/`, `src/agent.ts` |
| AGENTS.md discovery (walk-up + concat, override, byte budget) | ✅ shipped | `src/agents-md/` |
| 6 bash validators + auto-branch git | ✅ shipped | `src/permissions/bash/`, `src/tools/builtin/bash.ts` |
| 12 hook events (Codex-compatible names) | ✅ shipped | `src/hooks/` |
| Verifier (rule / llm / cross sources, CompositeVerifier) | ✅ shipped | `src/verifier/` |
| Federated scoreboard + 3-tuple reputation | ✅ shipped | `src/scoreboard/` |
| 5-step self-evolution (shadow default, owner-key signed) | ✅ shipped | `src/scoreboard/self-evolve.ts` |
| Per-call approval callback + `approval?` policy | ✅ shipped | `src/permissions/`, `src/agent.ts` |
| LSP client + 4 tools (types+managers, StdioLspClient, tools) | ✅ shipped | `src/lsp/` |
| Team + cron (TOML config, sequential, `${input}` substitution) | ✅ shipped | `src/team/`, `src/cron/` |
| `--json` trace + `AgentOptions.tracer` | ✅ shipped | `src/trace/` |
| Cross-agent verification (`CrossVerifyFn` + `defaultCrossVerify`) | ✅ shipped | `src/verifier/cross.ts`, `src/agent.ts` |
| **Mesh-native sub-agents** (Phase 5: `MeshSubmitter` seam, `LocalMeshSubmitter`, `task` tool, parallel fan-out + `maxSubagents=8`, `SubagentResultSigner`, `FanOutSpec` + capability-driven fan-out, cost aggregation, progress streaming, `subagentOf` trace annotation) | ✅ shipped | `src/subagent/` |
| `RemoteMeshSubmitter` (Package 3, thin wrapper over `RemoteSubmitterTransport`) | ✅ shipped | `packages/envoy-harness-adapter/src/remote-mesh-submitter.ts` |

### Interactive REPL (Phase 6) — `envoy-harness --repl`

| Capability | Status | Where |
|---|---|---|
| Single-Agent long-lived loop, session/hooks/AGENTS.md preserved across turns | ✅ shipped | `src/cli/repl/loop.ts` |
| Slash command registry (built-ins always win on name collision) | ✅ shipped | `src/cli/repl/registry.ts` |
| 9 F17.2 commands (`/help`, `/model`, `/provider`, `/sandbox`, `/approval`, `/clear`, `/cost`, `/status`, `/quit`) | ✅ shipped | `src/cli/repl/commands.ts` |
| 8 F17.2.5 info commands (`/session`, `/context`, `/scoreboard`, `/rules`, `/lsp`, `/hooks`, `/mcp`, `/profile`) | ✅ shipped | `src/cli/repl/commands-info.ts` |
| History persistence (F17.3) — read on start, write on exit, FIFO cap, env-var override, `historyPath:""` to disable | ✅ shipped | `src/cli/repl/loop.ts` |
| E2E wire-up tests (F17.4) | ✅ shipped | `test/repl-e2e.test.ts` |
| 3 F17.5 real-feature commands (`/new`, `/compact`, `/init`) | ✅ shipped | `src/cli/repl/commands-tier2.ts` |
| 2 F17.6 real-feature commands (`/agents`, `/diff`) | ✅ shipped | `src/cli/repl/commands-tier2-batch2.ts` |

### Persistent session log + bundled F18 commands (Phase 7) — `envoy-harness --persist` / `--resume` / `--fork`

| Capability | Status | Where |
|---|---|---|
| JSONL-backed `PersistedSession` (one file per session at `<session-dir>/<id>.jsonl`) | ✅ shipped | `src/session/persisted-session.ts` |
| `SessionStore` (load/create/createWithId/exists/list/delete, mtime-sorted list) | ✅ shipped | `src/session/session-store.ts` |
| `Session.setTitle` additive method (for `/rename` + persisted sessions) | ✅ shipped | `src/session.ts` |
| CLI: `--persist` (opt-in), `--resume <id>`, `--fork <id>`, `--session-dir <path>` (default `~/.local/state/envoy-harness/sessions`, env override) | ✅ shipped | `src/cli/run.ts` |
| REPL: `envoy-harness --repl --session-dir <path> --resume <id>` (load + continue) | ✅ shipped | `src/cli/repl/loop.ts` |
| REPL: `envoy-harness --repl --session-dir <path> --persist` (new persisted session) | ✅ shipped | `src/cli/repl/loop.ts` |
| 2 F14.1 commands (`/rename`, `/copy`) | ✅ shipped | `src/cli/repl/commands-tier2-batch3.ts` |
| 2 F14.3 commands (`/review`, `/export`) | ✅ shipped | `src/cli/repl/commands-tier2-batch4.ts` |

**REPL total: 26 built-in commands** (9 + 8 + 3 + 2 + 2 + 2 = 26 across 5 command files). `/undo` deferred to a future chunk (action journal scope; "testability wins on tie").

**Test count: 1094 tests across 74 files** (envoy-harness 1001 / 64 files + envoy-harness-adapter 93 / 10 files). All passing on `pnpm -r test`. Plus 3 opt-in live tests under `pnpm test:live` (real network; off by default).


## Installation

```sh
npm install -g @envoymesh/envoy-harness
# or
pnpm add -g @envoymesh/envoy-harness
```

The mesh integration (`@envoymesh/envoy-harness-adapter`) is a separate, optional package — only install it when you want envoy-harness to participate in an EnvoyMesh mesh.

## Quickstart

Set a provider key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or
`DEEPSEEK_API_KEY`, …), then:

```sh
# One-shot: read a prompt, run the agent, print the result.
envoy-harness --provider openai --model gpt-4o "explain this codebase"
envoy-harness --plan "add a /healthz endpoint to the API"
envoy-harness --sandbox=workspace-write "refactor the auth module"

# Interactive REPL: long-lived loop (default 200 turns, uncapped cost,
# auto-persist on TTY). Best for multi-hour work.
envoy-harness --repl --provider openai --model gpt-4o
envoy> /help
envoy> explain the auth module
envoy> /preset safe
envoy> /agents                 # local sub-agents from task
envoy> /quit

# Browser WebUI (primary GUI — spawns --acp)
envoy-harness web --provider openai --model gpt-4o --persist
# → http://127.0.0.1:5177/

# Sub-agents: LocalMeshSubmitter is ON by default (parallel task).
# Opt out with --no-subagents.

# Persistence
envoy-harness --persist "fix the bug in src/auth.ts"   # prints session id
envoy-harness --repl --resume <id>
envoy-harness --fork <source-id> "try a different approach"

# Standalone peers (LAN/WAN — no EnvoyMesh). See “Distributed features”.
envoy-harness --repl --peers alice@192.168.1.20:8123
```

Monorepo: `pnpm envoy -- …` and
`pnpm --filter @envoymesh/envoy-harness-web start`.

Detailed guide: repo root [`README.md`](../../README.md) and
[`QUICKSTART.md`](./QUICKSTART.md).

## Commands

`envoy-harness` is a single binary with subcommands. Run `envoy-harness --help`
for the authoritative list.

| Subcommand | What it does |
|---|---|
| `envoy-harness` (default = `run`) | One-shot agent run. |
| `envoy-harness --repl` | Interactive REPL — long-lived loop, slash commands, history. |
| `envoy-harness --acp` | ACP JSON-RPC on stdio (hosts / TUI / WebUI bridge). |
| `envoy-harness web` | Browser WebUI (`@envoymesh/envoy-harness-web`). |
| `envoy-harness tui` | Terminal UI host. |
| `envoy-harness team <team.toml>` | Multi-agent team from a TOML file. |
| `envoy-harness self-evolve` | One self-evolution cycle (shadow by default). |
| `envoy-harness doctor` | Health checks. |

### `run` flags

| Flag | Effect |
|---|---|
| `--provider <name>` | LLM provider: `openai` \| `anthropic` \| `deepseek` \| `minimax` \| `glm` \| `qwen` \| `ollama` (default: `deepseek`). `zhipu` = GLM, `dashscope` = Qwen aliases. |
| `--model <id>` | Model identifier. Defaults per provider: `gpt-4o`, `claude-sonnet-4-6`, `deepseek-chat`, `MiniMax-M3`, `glm-4-flash`, `qwen-plus`, `llama3.1`. |
| `--sandbox <mode>` | Permission mode: `read-only` (default) \| `workspace-write` \| `danger-full-access`. |
| `--approval <mode>` | Approval policy: `unless-trusted` \| `on-request` \| `granular` \| `never`. |
| `--cwd <path>` | Override working directory (default: `process.cwd()`). |
| `--max-turns <n>` | Cap agent-loop iterations (default **50** one-shot / **200** REPL). |
| `--max-cost-usd <n>` | Cost ceiling (default **$5** one-shot; **uncapped** REPL unless set). |
| `--repl` | Enter the interactive REPL. |
| `--acp` | Serve ACP on stdio. |
| `--persist` | Persist the new session to disk (REPL also auto-persists on TTY). |
| `--resume <session-id>` | Resume a saved session. |
| `--fork <session-id>` | Fork a saved session into a new branch (fresh id, original transcript). |
| `--session-dir <path>` | Session storage dir (default `~/.local/state/envoy-harness/sessions`; override via `ENVOY_HARNESS_SESSION_DIR`). |
| `--no-subagents` | Disable default local `task` / `LocalMeshSubmitter`. |
| `--peers <id>@<host:port>` | Static standalone peer (repeatable; also `ENVOY_PEERS`). |
| `--discovery <mode>` | Peer discovery: `static` \| `mdns` \| `none` (default `static`). |
| `--plan` | Plan-only mode: no tool execution, just the plan. |
| `--json` | Machine-readable JSON Lines output — pipe to `jq` or a trace viewer. |
| `--verbose` | Print hook fires and validator verdicts. |
| `--quiet` | Suppress human output. |
| `--no-color` | Disable ANSI colors. |

### WebUI (`envoy-harness web`)

Delegates to `@envoymesh/envoy-harness-web`. Typical flags: `--port`,
`--host`, `--cwd`, `--provider`, `--model`, `--persist`, `--no-subagents`,
`--peers`, `--dev`, `--no-open`. See
[`../envoy-harness-web/README.md`](../envoy-harness-web/README.md).

### `team` flags

| Flag | Effect |
|---|---|
| `<team.toml>` | Positional: path to the TOML team config. |
| `--input <s>` | The team-level input; substituted into each agent's objective as `${input}`. |
| `--model <id>`, `--provider <name>` | Override the model. |
| `--cwd <path>`, `--json`, `--quiet` | Same as `run`. |

### `self-evolve` flags

| Flag | Effect |
|---|---|
| `--scoreboard <path>` | Path to the scoreboard YAML (default: `~/.local/state/envoy-harness/scoreboard.yaml`). |
| `--snapshot-dir <path>` | Where the optimizer writes candidate snapshots. |
| `--benchmark <path>` | Frozen benchmark YAML for evaluating candidates. |
| `--ruleset <path>` | Live ruleset file (committed on `kept`). |
| `--commit` | Actually write the candidate on `kept` (default: shadow mode — no commit). |
| `--pull` | Opt in to federated pull (off by default). |
| `--adoptions <path>` | Federated adoptions YAML. |

## REPL commands

26 built-in slash commands, registered in registration order (custom commands first, built-ins last; built-ins always win on name collision). Run `/help` inside the REPL for the live list.

### Session + model (9, F17.2)

`/help` · `/model <id>` · `/provider <name>` · `/sandbox <mode>` · `/approval <mode>` · `/clear` · `/cost` · `/status` · `/quit` (alias `/exit`)

### Info (8, F17.2.5)

`/session` · `/context` · `/scoreboard` · `/rules` · `/lsp` · `/hooks` · `/mcp` · `/profile`

### Real features — batch 1 (3, F17.5)

`/new` — start a fresh session (new id, empty transcript).
`/compact [keep=N]` — drop oldest messages, keep the last N (default 20).
`/init` — generate AGENTS.md for the current cwd via a one-shot model call (doesn't pollute the main transcript).

### Real features — batch 2 (2, F17.6)

`/agents` — list spawned sub-agents from the session's `task` tool calls.
`/diff` — `git diff` vs HEAD (no diff → "no changes"; non-git dir → error to stderr).

### Real features — batch 3 (2, F14.1, Phase 7)

`/rename <title>` — set the session's display title (persisted sessions write through to disk; truncates to 100 chars).
`/copy` — print the last assistant response so you can pipe to `pbcopy` / `xclip` or read from scrollback.

### Real features — batch 4 (2, F14.3, Phase 7)

`/review [staged]` — model-as-reviewer of `git diff` (or `git diff --cached` with the `staged` arg). Empty diff → "no changes to review"; non-git dir → error to stderr. The model call is a one-shot side effect (not added to the main transcript).
`/export [format] [path]` — write the current session to disk. Formats: `jsonl` (default) and `md` (Markdown). Path: defaults to `<cwd>/<sessionId>.<ext>`.

## Persistence

The persistence layer is opt-in for one-shot. By default, one-shot sessions
are in-memory. Pass `--persist` to write to disk; use `--resume <id>` or
`--repl --resume <id>` to load it back. On a TTY, **REPL auto-persists**
(prints `auto-persisted session: <id>`).

### Storage

- **JSONL** (one file per session at `<session-dir>/<id>.jsonl`): header line + one message per line.
- **Default dir:** `~/.local/state/envoy-harness/sessions/`.
- **Override:** `--session-dir <path>` (CLI) or `ENVOY_HARNESS_SESSION_DIR` (env var).
- **Format:** see `src/session/persisted-session.ts` JSDoc.

### Mode matrix

| Mode | CLI | REPL |
|---|---|---|
| **Fresh in-memory** | `envoy-harness "prompt"` | tests / non-TTY without `--persist` |
| **Fresh persisted** | `envoy-harness --persist "prompt"` | TTY auto-persist, or `--persist` |
| **Resume saved** | `envoy-harness --resume <id> "next"` | `envoy-harness --repl --resume <id>` |
| **Fork saved** (copy + fresh id) | `envoy-harness --fork <id> "…"` | — (one-shot only in v0) |

`--resume` and `--fork` are mutually exclusive. Missing ids throw `CliError(EXIT_USAGE)`.

## Distributed features

**EnvoyMesh is optional.** The same `task` / team seams run locally or
across machines.

```text
LocalMeshSubmitter  →  PeerMeshSubmitter  →  RemoteMeshSubmitter
   (default)              (TCP --peers)         (EnvoyMesh adapter)
```

### Local parallel sub-agents (default)

CLI one-shot, REPL, and `--acp` (WebUI/TUI) inject `LocalMeshSubmitter`
unless `--no-subagents`. The model’s `task` tool runs child agents in
parallel under a concurrency cap.

### Standalone peers (LAN / WAN, no EnvoyMesh)

1. Start a peer worker (`@envoymesh/envoy-harness-peer`):

```sh
pnpm --filter @envoymesh/envoy-harness-peer exec \
  tsx bin/envoy-peer.ts serve \
  --port 8123 --peer-id alice --model deepseek-chat
```

2. Connect from CLI or WebUI:

```sh
# LAN
envoy-harness --repl --peers alice@192.168.1.20:8123

# WAN / public IP
envoy-harness web --peers alice@203.0.113.10:8123 --persist

# Several peers
envoy-harness --repl \
  --peers alice@192.168.1.20:8123 \
  --peers bob@192.168.1.21:8123
```

Also: `ENVOY_PEERS=alice@host:port,bob@host:port`.

Ensure TCP reachability (firewall / NAT / Tailscale). See the monorepo
root README for a full walkthrough.

### EnvoyMesh

Install `@envoymesh/envoy-harness-adapter` and run inside an EnvoyMesh
deployment when you want libp2p fabric, signed envelopes, and mesh
orchestration. Not required for LAN/WAN peer clusters.

## Configuration

### API keys (env vars)

| Provider | Env var | Notes |
|---|---|---|
| `openai` | `OPENAI_API_KEY` | Required. |
| `anthropic` | `ANTHROPIC_API_KEY` | Required. |
| `deepseek` | `DEEPSEEK_API_KEY` | Required. |
| `minimax` | `MINIMAX_API_KEY` | Required. Base `https://api.minimax.io/v1`; override via `MINIMAX_BASE_URL`. |
| `glm` / `zhipu` | `ZHIPU_API_KEY` | Required. Base `https://open.bigmodel.cn/api/paas/v4`; override via `GLM_BASE_URL` / `ZHIPU_BASE_URL`. |
| `qwen` / `dashscope` | `DASHSCOPE_API_KEY` | Required. Base `https://dashscope.aliyuncs.com/compatible-mode/v1`; override via `QWEN_BASE_URL` / `DASHSCOPE_BASE_URL`. |
| `ollama` | — | Keyless. Uses `http://localhost:11434/v1`; override via `OLLAMA_BASE_URL`. |

MiniMax, GLM, and Qwen use the OpenAI-compatible wire format, so their
tool-call responses are parsed exactly like OpenAI's (including the flat
`{ name, arguments }` shape some of these providers emit).

Optional `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` / `DEEPSEEK_BASE_URL`
override the upstream endpoint (useful for proxies). The CLI flag
`--base-url <url>` (and ACP `session/set_model` / WebUI Settings) wins
over those env vars for any supported provider.

### Profiles (TOML config)

> **v0 status:** the profile *seam* is shipped (the REPL's `/profile`
> command reads a host-injected `profileLoader`); the built-in TOML
> loader (`~/.config/envoy-harness/config.toml` /
> `$ENVOY_HARNESS_CONFIG`) is a planned chunk, not yet in the CLI.

Named profiles let hosts swap defaults without long CLI invocations:

```toml
# Default profile (used when no --profile is given)
[default]
provider = "anthropic"
model = "claude-sonnet-4-6"
sandbox = "read-only"
approval = "on-request"

# Override per project
[profiles.fast]
provider = "deepseek"
model = "deepseek-chat"
sandbox = "workspace-write"

[profiles.local]
provider = "ollama"
model = "llama3.1"
sandbox = "read-only"
```

```sh
envoy-harness --profile fast "refactor the auth module"
envoy-harness --profile local "summarize this file"
```

### History (REPL)

`~/.local/state/envoy-harness/history` (or `$ENVOY_HARNESS_HISTORY`) — read on REPL start, written on exit. FIFO-capped at 1000 lines. `/quit` and `/exit` are excluded from history (noise). Disable with `ENVOY_HARNESS_HISTORY=""` or `historyPath: ""` (programmatic).

## Embedding the harness (programmatic API)

For projects that want to embed the agent loop without the CLI:

```ts
import { Agent, InMemorySession, OpenAIAdapter, CostTracker } from "@envoymesh/envoy-harness";

const agent = new Agent({
  model: new OpenAIAdapter({ apiKey: process.env.OPENAI_API_KEY! }),
  session: new InMemorySession(crypto.randomUUID(), {
    cwd: process.cwd(),
    permissionMode: "read-only",
    startedAt: new Date().toISOString(),
  }),
  // Optional: hooks, tools, lspManager, maxIterations, maxCostUsd, ...
});

const result = await agent.run("explain this codebase");
console.log(result.content);
```

Key additive surface (Package 1 public API):
- `Agent` (constructor + `run` + 17 public methods: `setModel`, `setAskHandler`, `setPermissionMode`, `getPermissionMode`, `clearSession`, `getCost`, `getSessionId`, `getSession`, `getMessageCount`, `getLspServers`, `getHooks`, `newSession`, `compact`, `getModel`, `getMeshSubmitter`, `setTitle`, `abort` (action; cancels the in-flight run via the `AbortController`))
- `Session` + `InMemorySession` + `PersistedSession` + `SessionStore` (Phase 7)
- `ModelAdapter` + provider adapters (`OpenAIAdapter`, `AnthropicAdapter`, `DeepSeekAdapter`, `createProviderAdapter`)
- `ToolRegistry` + `BUILTIN_TOOLS` (bash, read_file, plus your custom tools)
- `HookRegistry` + 12 hook events
- `runRepl` (interactive REPL with 26 built-in commands)
- `run` (the CLI runner, for hosted TUI/web wrappers)

See [`QUICKSTART.md`](./QUICKSTART.md) for full embedding examples (custom tools, custom hooks, custom mesh submitter).

## Integrating with EnvoyMesh (Package 3)

envoy-harness is the local runtime; EnvoyMesh is the mesh fabric. The bridge is `envoy-harness-adapter` (Package 3) — install only when you want to participate in a mesh.

```sh
pnpm add @envoymesh/envoy-harness-adapter
```

```ts
import { EnvoyHarnessAdapter, RemoteMeshSubmitter } from "@envoymesh/envoy-harness-adapter";

// The adapter implements the mesh-side `AgentAdapter`
// contract over envoy-harness. It's the reference
// implementation that ships in Package 3.
const adapter = new EnvoyHarnessAdapter({
  buildAgent: defaultBuildAgentFactory({ cwd: process.cwd() }),
  // ...other adapter options
});

// For sub-agents, swap LocalMeshSubmitter for
// RemoteMeshSubmitter: same MeshSubmitter interface,
// thin wrapper over the mesh transport.
const meshSubmitter = new RemoteMeshSubmitter({
  transport: /* your mesh transport (libp2p / HTTP / etc.) */,
});
```

See [`docs/boundary.en.md`](./docs/boundary.en.md) for the package boundary contract; `QUICKSTART.md` for the full integration story.

## Documentation

- [`docs/design.en.md`](./docs/design.en.md) — the full design (English, source of truth)
- [`docs/design.zh.md`](./docs/design.zh.md) — 中文版
- [`docs/boundary.en.md`](./docs/boundary.en.md) — package boundary one-pager (envoy-harness vs envoy-harness-adapter vs EnvoyMesh)
- [`docs/implementation-plan.md`](./docs/implementation-plan.md) — the single source of truth for **what shipped, where it lives, what's still open** (per-sub-chunk commit history + test inventory)
- [`QUICKSTART.md`](./QUICKSTART.md) — focused how-to: use it, embed it, integrate with EnvoyMesh
- The MAP protocol that envoy-harness speaks is defined in `EnvoyMesh/docs/agent-network-architecture.md` (in the EnvoyMesh repo, the predecessor design doc)

## Project layout

```
packages/
  envoy-harness/                          # Package 1: this package
    src/
      agent.ts             # the agent loop
      cli/                 # the `envoy` command (run.ts, argv.ts, repl/)
        repl/             # Phase 6 + 7: interactive REPL
          loop.ts         # runRepl + history + BUILTIN_*_COMMANDS wire-in
          commands.ts     # 9 F17.2 commands
          commands-info.ts # 8 F17.2.5 commands
          commands-tier2.ts       # 3 F17.5 (/new, /compact, /init)
          commands-tier2-batch2.ts # 2 F17.6 (/agents, /diff)
          commands-tier2-batch3.ts # 2 F14.1 (/rename, /copy)
          commands-tier2-batch4.ts # 2 F14.3 (/review, /export)
      session/            # Phase 7: PersistedSession + SessionStore
      subagent/            # Phase 5: mesh-native sub-agents (MeshSubmitter seam)
      lsp/                 # LSP client + 4 tools
      hooks/               # 12 hook events
      verifier/            # rule/llm/cross verifier
      scoreboard/          # federated scoreboard
      permissions/         # bash validators + sandbox policy
      llm/                 # LLM adapters (openai, anthropic, deepseek, http)
      trace/               # tracer + JSON Lines output
      ...                  # other capability seams
    test/                  # 932 unit + integration tests
    docs/                  # design, boundary, implementation-plan
    .github/               # CI workflows
  envoy-harness-adapter/                  # Package 3: the mesh bridge
    src/
      adapter.ts          # EnvoyHarnessAdapter (MAP AgentAdapter reference impl)
      remote-mesh-submitter.ts  # F10.3.2: thin wrapper over RemoteSubmitterTransport
      ...                 # ~92 tests
```

## Building from source

```sh
pnpm install
pnpm run typecheck     # both packages
pnpm -r test           # both packages (1094 tests + 3 opt-in live)
pnpm -r build          # both packages
```

Node 22+ (see `.nvmrc`).

## License

Apache-2.0. See [LICENSE](./LICENSE).
