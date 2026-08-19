# @envoymesh/envoy-harness

> **Status (this package):** **Phases 0–7 complete** (7 sub-phases:
> v0 spine, mesh-native, self-evolution, production-grade, mesh-native
> sub-agents, interactive REPL, persistent session log + bundled F18
> gap-analysis commands). The CLI agent in Package 1 is the reference
> implementation of MAP's `AgentRuntime = envoy-harness` value, and the
> only adapter that ships a full local sub-agent path. The mesh
> integration lives in [`@envoymesh/envoy-harness-adapter`](../envoy-harness-adapter)
> (Package 3) — a thin bridge, not a fork. **The package works without
> a mesh;** `npm install -g @envoymesh/envoy-harness` runs on a stock
> laptop.

EnvoyMesh's home-team agent harness. Production-grade CLI agent with four design targets, all load-bearing:

- **EnvoyMesh-native** — speaks the MAP protocol natively, sub-agents can run on any node in the mesh.
- **Independently runnable** — `npm install -g @envoymesh/envoy-harness` works without any mesh, any peer, any EnvoyMesh install.
- **Easy to integrate elsewhere** — any project can depend on this and write a ~500 LoC adapter against the stable `@envoymesh/protocol` contract.
- **Self-contained, fully independently testable** — test suite passes in complete isolation: no mesh, no peer, no network, no `libp2p` daemon, no live LLM key.

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

### Interactive REPL (Phase 6) — `envoy --repl`

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

### Persistent session log + bundled F18 commands (Phase 7) — `envoy --persist` / `--resume` / `--fork`

| Capability | Status | Where |
|---|---|---|
| JSONL-backed `PersistedSession` (one file per session at `<session-dir>/<id>.jsonl`) | ✅ shipped | `src/session/persisted-session.ts` |
| `SessionStore` (load/create/createWithId/exists/list/delete, mtime-sorted list) | ✅ shipped | `src/session/session-store.ts` |
| `Session.setTitle` additive method (for `/rename` + persisted sessions) | ✅ shipped | `src/session.ts` |
| CLI: `--persist` (opt-in), `--resume <id>`, `--fork <id>`, `--session-dir <path>` (default `~/.local/state/envoy-harness/sessions`, env override) | ✅ shipped | `src/cli/run.ts` |
| REPL: `envoy --repl --session-dir <path> --resume <id>` (load + continue) | ✅ shipped | `src/cli/repl/loop.ts` |
| REPL: `envoy --repl --session-dir <path> --persist` (new persisted session) | ✅ shipped | `src/cli/repl/loop.ts` |
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

```sh
# One-shot: read a prompt, run the agent, print the result.
envoy "explain this codebase"
envoy --plan "add a /healthz endpoint to the API"
envoy --sandbox=workspace-write "refactor the auth module"

# Sub-agents: the `task` tool spawns a sub-agent in a NEW session.
# (Package 1 = local; Package 3 = routed to a remote peer.)
envoy task "translate this doc to zh"

# Interactive REPL: long-lived loop, slash commands, history.
envoy --repl
envoy> /help
envoy> explain the auth module
envoy> /review              # model reviews git diff
envoy> /rename "auth refactor"
envoy> /export md           # write the session as Markdown
envoy> /quit

# Persistence: one-shot → save → REPL → resume.
envoy --persist "fix the bug in src/auth.ts"        # prints session id to stderr
envoy --repl --session-dir ~/.local/state/envoy-harness/sessions --resume <id>

# Fork: copy a saved session into a new branch (new id, original transcript).
envoy --fork <source-id> "try a different approach"
```

## Commands

`envoy` is a single binary with subcommands. Run `envoy --help` for the authoritative list; the table below is the v0 surface.

| Subcommand | What it does |
|---|---|
| `envoy` (default = `run`) | One-shot agent run. Reads a prompt (positional or stdin), runs the agent loop, prints the result. |
| `envoy --repl` | Interactive REPL (Phase 6) — long-lived loop, 26 built-in slash commands, history. |
| `envoy team <team.toml>` | Run a multi-agent team from a TOML file (F9.3). |
| `envoy self-evolve` | Run one 5-step self-evolution cycle (Phase 3, shadow mode by default). |

### `run` flags

| Flag | Effect |
|---|---|
| `--provider <name>` | LLM provider: `openai` \| `anthropic` \| `deepseek` \| `ollama` (default: `deepseek`). |
| `--model <id>` | Model identifier. Defaults per provider: `gpt-4o`, `claude-sonnet-4-6`, `deepseek-chat`, `llama3.1`. |
| `--sandbox <mode>` | Permission mode: `read-only` (default) \| `workspace-write` \| `danger-full-access`. |
| `--approval <mode>` | Approval policy: `unless-trusted` \| `on-request` \| `granular` \| `never`. |
| `--cwd <path>` | Override working directory (default: `process.cwd()`). |
| `--max-turns <n>` | Cap agent-loop iterations. |
| `--max-cost-usd <n>` | Cost ceiling for the run; agent aborts when reached. |
| `--repl` | Enter the interactive REPL. |
| `--persist` | Persist the new session to disk (for `--resume` later). Prints the session id to stderr. |
| `--resume <session-id>` | Resume a saved session. |
| `--fork <session-id>` | Fork a saved session into a new branch (fresh id, original transcript). |
| `--session-dir <path>` | Session storage dir (default `~/.local/state/envoy-harness/sessions`; override via `ENVOY_HARNESS_SESSION_DIR`). |
| `--plan` | Plan-only mode: no tool execution, just the plan. |
| `--json` | Machine-readable JSON Lines output (F9.4) — pipe to `jq` or a trace viewer. |
| `--verbose` | Print hook fires and validator verdicts. |
| `--quiet` | Suppress human output; only stream-json. |
| `--no-color` | Disable ANSI colors. |

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

The persistence layer is opt-in. By default, sessions are in-memory (the v0 behavior). Pass `--persist` to write the session to disk; use `--resume <id>` (one-shot) or `--repl --resume <id>` (REPL) to load it back.

### Storage

- **JSONL** (one file per session at `<session-dir>/<id>.jsonl`): header line + one message per line.
- **Default dir:** `~/.local/state/envoy-harness/sessions/`.
- **Override:** `--session-dir <path>` (CLI) or `ENVOY_HARNESS_SESSION_DIR` (env var).
- **Format:** see `src/session/persisted-session.ts` JSDoc.

### Mode matrix

| Mode | CLI | REPL |
|---|---|---|
| **Fresh in-memory** (default) | `envoy "prompt"` | `envoy --repl` |
| **Fresh persisted** | `envoy --persist "prompt"` (prints id to stderr) | `envoy --repl --session-dir <path> --persist` |
| **Resume saved** | `envoy --resume <id> "next prompt"` | `envoy --repl --session-dir <path> --resume <id>` |
| **Fork saved** (copy + fresh id) | `envoy --fork <id> "alternate approach"` | — (deferred; one-shot only in v0) |

`--resume` and `--fork` are mutually exclusive. `--resume <missing-id>` (and `--fork <missing-id>`) throw `CliError(EXIT_USAGE)`.

## Configuration

### API keys (env vars)

| Provider | Env var | Notes |
|---|---|---|
| `openai` | `OPENAI_API_KEY` | Required. |
| `anthropic` | `ANTHROPIC_API_KEY` | Required. |
| `deepseek` | `DEEPSEEK_API_KEY` | Required. |
| `ollama` | — | Keyless. Uses `http://localhost:11434/v1`; override via `OLLAMA_BASE_URL`. |

Optional `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` / `DEEPSEEK_BASE_URL` override the upstream endpoint (useful for proxies).

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
envoy --profile fast "refactor the auth module"
envoy --profile local "summarize this file"
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
