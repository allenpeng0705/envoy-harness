# QuickStart

Focused how-to for `@envoymesh/envoy-harness`. Three layers, one
document:

1. **Use it** — install + one-shot + REPL + persistence.
2. **Embed it** — drop the agent loop into your own app.
3. **Bridge to EnvoyMesh** — flip the local sub-agent to remote via Package 3.

**Build + run (CLI and WebUI in detail):**
[`docs/build-and-run.md`](./docs/build-and-run.md) — prerequisites, workspace
build order, every CLI mode, WebUI architecture, troubleshooting.

> The four design targets — EnvoyMesh-native, Independently runnable,
> Easy to integrate elsewhere, Self-contained testable — show up in all
> three layers. v0 is the first three, and `easy to integrate elsewhere`
> is what this document makes concrete.

---

## Part 1: Use it

### Install

**Published binary name:** `envoy-harness` (examples below use that).
In the monorepo, `pnpm envoy -- …` is the same entry from source.

```sh
# From npm (global)
npm install -g @envoymesh/envoy-harness
# or
pnpm add -g @envoymesh/envoy-harness

# From this monorepo (recommended while developing)
pnpm install
pnpm run build          # required on a fresh clone
pnpm envoy -- --help
```

Set one API key (any of `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
`DEEPSEEK_API_KEY`; the first time you run without a key, the CLI
tells you which one is missing).

```sh
export ANTHROPIC_API_KEY=sk-...
```

### CLI Quick Reference

Default mode is one-shot; flags like `--repl` / `--acp` select other
hosts. Subcommands (`web`, `tui`, `team`, …) are positional. The full
flag set + the 26 built-in REPL commands are below; this table is the
scannable overview.

**Modes / subcommands:**

| Command | Purpose |
|---|---|
| `envoy-harness [flags] "<prompt>"` | One-shot: read prompt, run, print result. Default mode. |
| `envoy-harness --repl` | Long-lived interactive loop. 26 slash commands. |
| `envoy-harness --acp` | ACP JSON-RPC on stdio (WebUI / TUI spawn this). |
| `envoy-harness web` | Browser WebUI (`@envoymesh/envoy-harness-web`). |
| `envoy-harness tui` | Terminal UI host. |
| `envoy-harness team <team.toml>` | Sequential multi-agent run from a TOML config. |
| `envoy-harness self-evolve` | Shadow self-evolution cycle (verifier rules). Off by default. |
| `envoy-harness doctor` | Health checks. |

**Common flags** (for `run` + `--repl`):

| Flag | Default | What it does |
|---|---|---|
| `--provider <name>` | (env) | `openai` / `anthropic` / `deepseek` / `ollama` |
| `--model <id>` | provider default | Model identifier (e.g. `gpt-4o`, `claude-sonnet-4-6`) |
| `--cwd <path>` | `process.cwd()` | Working directory for tool execution |
| `--permission-preset <p>` | — | `safe` / `ask-all` / `approve-all` / `mobile` / `webdev` (one knob; see below) |
| `--sandbox <mode>` | `read-only` | `read-only` / `workspace-write` / `danger-full-access` |
| `--approval <policy>` | `on-request` | `unless-trusted` / `on-request` / `granular` / `never` |
| `--max-turns <n>` | 50 (one-shot) / 200 (REPL) | Max agent iterations before force-stop |
| `--max-cost-usd <usd>` | 5.00 (one-shot) / unlimited (REPL) | Cost ceiling; aborts the run when reached |
| `--config <path>` | (env / default) | TOML config file; overrides env + default |
| `--session-dir <path>` | `~/.local/state/envoy-harness/sessions` | Where persisted sessions live |
| `--resume <id>` | none | Continue a saved session |
| `--fork <id>` | none | Copy a saved session + new id |
| `--persist` | off (REPL auto-persists when TTY) | Save the run's session to disk |
| `--no-subagents` | off | Disable default local `task` / LocalMeshSubmitter |
| `--peers <id>@host:port` | none | Static peer cluster (also `ENVOY_PEERS`) |
| `--json` | off | JSON Lines trace output (machine-readable) |
| `--plan` | off | Plan-only mode (no tool execution) |
| `--no-color` / `--verbose` / `--quiet` | off | Output knobs |

### Browser WebUI

Primary GUI. Spawns a local `envoy-harness --acp` child and serves the
React app (default **http://127.0.0.1:5177/**).

```sh
# Monorepo
pnpm run build    # once on a fresh clone
pnpm --filter @envoymesh/envoy-harness-web start -- \
  --provider openai --model gpt-4o --persist

# Same via CLI (monorepo or installed package)
pnpm envoy -- web --provider openai --model gpt-4o --persist
envoy-harness web --provider openai --model gpt-4o --persist

# Force Vite middleware / skip auto-open
envoy-harness web --dev --no-open --port 5177

# With standalone TCP peers
envoy-harness web --peers alice@127.0.0.1:7400 --persist \
  --provider openai --model gpt-4o
```

Typical flags: `--port` · `--host` · `--cwd` · `--provider` · `--model` ·
`--base-url` · `--persist` · `--no-subagents` · `--peers` · `--dev` ·
`--no-open`. Details:
[`../envoy-harness-web/README.md`](../envoy-harness-web/README.md) ·
repo root [WebUI section](../../README.md#how-to-use-the-webui).

**Environment variables:**

| Var | Purpose |
|---|---|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` | Provider API key (one required) |
| `ENVOY_HARNESS_CONFIG` | Path to the user-config TOML file (overrides default) |
| `ENVOY_HARNESS_SESSION_DIR` | Default `--session-dir` (overrides the XDG default) |
| `OLLAMA_BASE_URL` | Override the Ollama endpoint (default `http://localhost:11434/v1`) |
| `RUN_LIVE_TESTS=1` | Opt-in for the `pnpm test:live` lane (developer only) |

### One-shot run

```sh
# Read a prompt, run the agent loop, print the result.
envoy-harness "explain the auth module"

# Plan-only (no tool execution).
envoy-harness --plan "add a /healthz endpoint to the API"

# Permission modes: read-only | workspace-write | danger-full-access
envoy-harness --sandbox=workspace-write "refactor the auth module"

# Cost ceiling — the agent aborts when reached.
envoy-harness --max-cost-usd=2.50 "write tests for src/auth.ts"

# Pipe a prompt from stdin.
echo "summarize the diff" | envoy-harness -

# JSON Lines output (machine-readable; for trace viewers / `jq`).
envoy-harness --json "explain this" | tee /tmp/envoy-trace.jsonl

# Monorepo shorthand (same binary via tsx):
# pnpm envoy -- "explain the auth module"
```

### Permission presets (recommended)

One control expands sandbox + approval + auto-run (and domain roots):

| Preset | Sandbox | Approval | Auto-run | Unlocks |
|---|---|---|---|---|
| `safe` | read-only | unless-trusted | always-confirm | — |
| `ask-all` | workspace-write | on-request | always-confirm | — |
| `approve-all` | danger-full-access | never | off | — |
| `mobile` | workspace-write | on-request | safe-only | `device_*` (Simulator/SDK roots) |
| `webdev` | workspace-write | on-request | safe-only | `browser_*` (Vite/Next/Playwright caches) |

```sh
envoy-harness --permission-preset mobile --repl …
envoy-harness --permission-preset webdev --repl …
# REPL: /preset mobile | /preset webdev
# config.toml: permission_preset = "webdev"
# ACP: session/set_policy { "preset": "webdev" }
```

Details: [`docs/mobile.md`](./docs/mobile.md), [`docs/webdev.md`](./docs/webdev.md).

### Permission modes

Three modes, set via `--sandbox <mode>` (or `permission_mode` in
the TOML config). The default is `read-only`. Prefer `--permission-preset`
when you want approval + auto-run + domain roots together.

| Mode | Reads | Writes | Bash mutations | Sub-agents |
|---|---|---|---|---|
| `read-only` | ✓ | ✗ | ✗ (6 validators + interpreter blocking) | ✓ |
| `workspace-write` | ✓ | cwd + `writable_roots` | within allowed paths | ✓ |
| `danger-full-access` | ✓ | anywhere | anywhere (no validators) | ✓ |

The REPL `/sandbox` slash command swaps mode mid-session; the
new mode takes effect on the next tool call (live-getter pattern
in `ToolExecutor` so the bash / write / edit tools re-read policy
on every invocation).

### Approval policy

Four values, set via `--approval <policy>` (or `ask_for_approval`
in the TOML config). The default is `on-request`.

| Value | Behavior |
|---|---|
| `unless-trusted` | Strict; only bash commands that pass `is_safe_command()` auto-approve. Anything else asks. |
| `on-request` | **Default.** The model decides when to ask. Pre-tool hooks can still block. |
| `granular` | Per-tool on/off via config (e.g. allow `read_file`, ask on `bash`, deny `write`). |
| `never` | Auto-approve everything. The 6 bash validators still apply; this only bypasses the prompt. |

The REPL `/approval` slash command swaps policy mid-session; takes
effect on the next tool call.

### Configuration (TOML)

The v0 config layer is a single TOML file. Three resolution paths
(highest priority first):

1. `--config <path>` (per-invocation)
2. `$ENVOY_HARNESS_CONFIG` (per-shell)
3. `~/.config/envoy-harness/config.toml` (per-user; respects `$XDG_CONFIG_HOME`)

Missing file = `{}` (the loader returns an empty config; the CLI
defaults apply). The schema is zod `.strict()` — a typo in any
field name surfaces as `ConfigLoadError` instead of being silently
ignored.

Core fields (subset; schema grows over time):

| Field | Type | Effect |
|---|---|---|
| `permission_preset` | enum | One knob: `safe` / `ask-all` / `approve-all` / `mobile` / `webdev` |
| `permission_mode` | enum | Initial sandbox mode for the agent |
| `ask_for_approval` | enum | Initial approval policy |
| `auto_run` | enum | `always-confirm` / `safe-only` / `off` |
| `sandbox_backend` | string | Kernel sandbox: `linux-landlock` / `darwin-sandbox` / `windows-sandbox` / `none` (win32 uses job object + optional sidecar) |
| `network_access` | bool | Allow network in restricted sandbox modes (backend-dependent) |
| `slash_tmp_writable` | bool | Allow `/tmp` writes in `workspace-write` when the sandbox backend honors it |
| `writable_roots` | array of paths | Additional paths allowed in `workspace-write` beyond `cwd` |

Example `~/.config/envoy-harness/config.toml`:

```toml
permission_preset = "webdev"
# Or set axes explicitly:
# permission_mode = "workspace-write"
# ask_for_approval = "on-request"
writable_roots = ["/Users/me/projects"]
# On Windows:
# sandbox_backend = "windows-sandbox"
```

Precedence: **CLI > config > default**. So
`envoy-harness --sandbox=danger-full-access` wins over the config file's
`permission_mode`. (Design §20.1.)

### Interactive REPL

The REPL is the long-lived loop: one `Agent`, one `Session`, many
turns. Hooks, AGENTS.md, and permission state are preserved across
turns. 26 built-in slash commands, in 5 files.

| Group | Commands |
|---|---|
| **Core** | `/help` · `/model` · `/provider` · `/sandbox` · `/approval` · `/preset` · `/clear` · `/cost` · `/status` · `/quit` |
| **Info (8)** | `/session` · `/context` · `/scoreboard` · `/rules` · `/lsp` · `/hooks` · `/mcp` · `/profile` |
| **Tier 2 (3)** | `/new` · `/compact` · `/init` |
| **Batch 2 (2)** | `/agents` · `/diff` |
| **Batch 3 (2)** | `/rename` · `/copy` |
| **Batch 4 (2)** | `/review` · `/export` |

The `/mcp` command reads the real `McpClientRegistry` (T3.3);
`/lsp` reads the `LspManager`; `/hooks` lists the active
`HookRegistry`. The info commands are read-only — they don't
mutate the session.

```sh
envoy-harness --repl
# monorepo: pnpm envoy -- --repl
```

On a TTY, the REPL **auto-persists** the session (prints
`auto-persisted session: <id>`). Resume later with `--resume <id>`.
Default turn budget is **200** (vs 50 one-shot); cost is **uncapped**
unless you pass `--max-cost-usd`. Use `/preset safe` (or `/approval` /
`/sandbox`) for intermittent permissions on multi-hour runs.
Background bash uses `job_start` when environment tools are wired;
per-command bash timeout is the tool's `timeoutMs` (default 30s).

```
envoy> /help                       # list all 26 commands
envoy> /model claude-sonnet-4-6    # swap model mid-session
envoy> explain the auth module
... agent runs, prints text ...
envoy> /compact                   # drop oldest messages, keep last 20
envoy> /review                    # model reviews git diff
envoy> /rename "auth refactor"    # set display title
envoy> /export md ~/audit.md      # write the session as Markdown
envoy> /quit
```

Resume a persisted session in the REPL:

```sh
envoy-harness --repl --session-dir ~/.local/state/envoy-harness/sessions --resume <id>
```

The session's history (transcript, cwd, permission mode) is restored;
the loop is the same, the slash commands are the same.

### Persistence round-trip

```sh
# 1. One-shot, save to disk.
envoy-harness --persist "fix the bug in src/auth.ts"
# stderr: persisted session: 7c2b3e4d-...

# 2. Resume in REPL.
envoy-harness --repl --session-dir ~/.local/state/envoy-harness/sessions --resume 7c2b3e4d-...

# 3. Fork a saved session (copy + new id, original transcript).
envoy-harness --fork 7c2b3e4d-... "try a different approach"
```

The JSONL format is append-friendly and human-readable:

```sh
cat ~/.local/state/envoy-harness/sessions/<id>.jsonl
# {"_kind":"header","id":"...","metadata":{...}}
# {"role":"user","content":[...]}
# {"role":"assistant","content":[...]}
# ...
```

Override the storage location per-invocation (`--session-dir`) or per-environment (`ENVOY_HARNESS_SESSION_DIR`).

### Subcommands

Beyond the default one-shot and `--repl`, two subcommands ship
in v0:

**`envoy-harness team <team.toml>`** — multi-agent run from a TOML config.
Agents run sequentially; `${input}` is substituted into each
agent's `objective`; `depends_on` wires the dependency graph.
Output: each agent's transcript + result.

```toml
# team.toml
[team]
name = "release-prep"
input = "release v0.1.0"

[[team.agents]]
name = "writer"
objective = "draft release notes from ${input}"
model = "claude-sonnet-4-6"

[[team.agents]]
name = "reviewer"
objective = "review the writer's output for ${input}"
model = "claude-sonnet-4-6"
depends_on = ["writer"]
```

```sh
envoy-harness team ./team.toml
envoy-harness team ./team.toml --input "release v0.2.0" --json
```

**`envoy-harness self-evolve`** — the shadow self-evolution cycle
(design §13.1). Reads the committed `verifier-rules.json`,
runs N cycles, and either prints what would change (default
shadow) or writes a new ruleset (`--commit`).

```sh
# Shadow run (default; doesn't write). Reads verifier-rules.json,
# runs N cycles, prints what would change. No file writes.
envoy-harness self-evolve

# Commit run: actually write the candidate ruleset on kept.
envoy-harness self-evolve --commit

# Opt in to federated pull (off by default per design §13.3).
envoy-harness self-evolve --pull --peer-id <your-peer-id>
```

The cycle is: read recent scoreboard failures → propose a rule
swap → run the verifier → shadow-apply on `kept` → record
adoption (sign + hash). The federated cycle NEVER commits
even when kept (v0: pull-only, no auto-adopt; design §13.3).

### Sub-agents

The `task` tool spawns a sub-agent in a **new session** (own id, own
AGENTS.md, own hooks, own permission — even when local). In Package
1, sub-agents run locally; in Package 3, they're routed to a remote
peer.

```sh
# Prefer asking the model to use the `task` tool (on by default).
envoy-harness --persist "research X with a sub-agent via task"

# From the REPL:
envoy> research the EnvoyMesh runbook with a task sub-agent
envoy> /agents                # list spawned sub-agents + their status
```

The agent's `MeshSubmitter` is the swap point: `LocalMeshSubmitter`
(default) vs `RemoteMeshSubmitter` (Package 3). The same `task` tool
call works either way.

### Capabilities at a glance

These ship but aren't central to the CLI flow. The CLI exposes them
via flags, env vars, or REPL commands; the API for embedding them
lives in Part 2.

| Capability | Where it's exposed | API surface |
|---|---|---|
| **AGENTS.md discovery** | Always on (read-only, on every run) | `discoverAgentsMd(cwd, options?)` in `src/agents-md/` |
| **Hooks** (12 events, Codex-compatible names) | Always on; the REPL `/hooks` command lists them | `HookRegistry` + `agent.hooks` |
| **LSP tools** (`lsp_*`, 4 tools) | On when an `LspManager` is wired; REPL `/lsp` lists status | `LspManager` + `makeLspTools(...)` in `src/lsp/` |
| **Verifier** (rule / llm / cross sources) | `envoy-harness self-evolve` + REPL `/rules` | `DEFAULT_RULES` + `runVerifierRules(rules, ctx)` in `src/verifier/` |
| **Scoreboard + federated adoptions** | `envoy-harness self-evolve --pull` + REPL `/scoreboard` | `FederatedScoreboard` in `src/scoreboard/` |
| **Self-evolve** | `envoy-harness self-evolve [--commit] [--pull]` | `SelfEvolve.runOneCycle(...)` in `src/scoreboard/self-evolve.ts` |
| **JSON Lines trace** | `envoy-harness --json` | `JsonLinesTracer` in `src/trace/` |
| **MCP (type seam)** | REPL `/mcp` (reads the real `McpClientRegistry`) | `McpClientRegistry` in `src/mcp/` (stdio transport pending) |
| **TOML config** | `--config <path>` + `$ENVOY_HARNESS_CONFIG` | `loadConfig({filePath?})` in `src/config/` |
| **Cost tracking** | Always on; `envoy-harness --max-cost-usd` cap | `CostTracker` in `src/cost.ts` |
| **Cross-agent verification** | `agent.crossVerify?: CrossVerifyFn` | `defaultCrossVerify` in `src/verifier/cross.ts` |
| **5 built-in tools** | `read_file`, `bash`, `write`, `edit`, `git` (read-only subset) | `BUILTIN_TOOLS` in `src/tools/builtin/` |

---

## Part 2: Embed it

For projects that want the agent loop without the CLI.

### Minimal: build an `Agent` and run a turn

```ts
import {
  Agent,
  InMemorySession,
  createProviderAdapter,
  newSessionId,
} from "@envoymesh/envoy-harness";

const model = createProviderAdapter({
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  // Reads ANTHROPIC_API_KEY from env automatically.
});

const session = new InMemorySession(newSessionId(), {
  cwd: process.cwd(),
  permissionMode: "read-only",
  startedAt: new Date().toISOString(),
  title: "embed demo",
});

const agent = new Agent({ model, session });
const result = await agent.run("summarize the diff");

// result.content: ReadonlyArray<ContentBlock>
// result.stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted"
// result.metrics: { costUsd, inputTokens, outputTokens, ... }
// result.iterations: number
console.log(result.content);
```

### With a custom tool

The agent loop calls `ToolContext.execute(...)` on each tool. To
register your own:

```ts
import {
  Agent,
  HookRegistry,
  ToolRegistry,
  type Tool,
  type ContentBlock,
} from "@envoymesh/envoy-harness";
import { z } from "zod";

const myTool: Tool<z.ZodObject<{ query: z.ZodString }>> = {
  name: "search",
  description: "Search the user's local docs index for `query`.",
  parameters: z.object({ query: z.string().describe("the search query") }),
  async execute({ query }, ctx) {
    // ctx.cwd, ctx.session, ctx.signal, ctx.sandboxPolicy all available
    const hits = await myLocalSearch(query, ctx.cwd);
    return {
      content: [{ type: "text", text: hits.map((h) => h.title).join("\n") }],
      isError: false,
    };
  },
};

const tools = new ToolRegistry();
tools.register(myTool);

const agent = new Agent({
  model,
  session,
  tools,         // override the default BUILTIN_TOOLS
  hooks: new HookRegistry(),
});
```

### With hooks (Codex-compatible names)

```ts
import { HookRegistry } from "@envoymesh/envoy-harness";

const hooks = new HookRegistry();

hooks.on("PreToolUse", async (event) => {
  if (event.tool === "bash" && /rm -rf/.test(event.args.command)) {
    return { kind: "deny", reason: "no rm -rf in production" };
  }
  return { kind: "allow" };
});

hooks.on("PostToolUse", async (event) => {
  console.log(`tool ${event.tool} done in ${event.durationMs}ms`);
});

const agent = new Agent({ model, session, hooks });
```

12 hook events: `SessionStart`, `SessionEnd`, `PreUserMessage`,
`PostUserMessage`, `PreToolUse`, `PostToolUse`, `PreModelCall`,
`PostModelCall`, `PreCompact`, `PostCompact`, `Notification`,
`SubagentStart`, `SubagentEnd`.

### With persistence

```ts
import { PersistedSession, SessionStore } from "@envoymesh/envoy-harness";

const store = new SessionStore({
  dir: process.env.ENVOY_HARNESS_SESSION_DIR
    ?? `${process.env.HOME}/.local/state/envoy-harness/sessions`,
});

// Create a new persisted session.
const session = await store.create({
  cwd: process.cwd(),
  permissionMode: "read-only",
  startedAt: new Date().toISOString(),
  title: "user support ticket #42",
});

// ... later ...
const agent = new Agent({ model, session });
await agent.run("first response");

// After the run, the session file is on disk.
// The user can resume it later (CLI or REPL).
```

### With the REPL (programmatic)

```ts
import { runRepl, scriptedModel } from "@envoymesh/envoy-harness";

await runRepl({
  model,
  args: { /* RunParsedArgs — see argv.ts */ },
  lineReader: myCustomLineReader,
  // Optional: historyPath, customCommands, lspManager,
  // scoreboard, verifierRules, subagentRegistry,
  // sessionStore + resumeFromId, createSession, etc.
});
```

The REPL is the same long-lived loop the CLI uses; the options
mirror everything you'd want to override for a hosted TUI or a web
wrapper.

### Custom mesh submitter (v0 ships `LocalMeshSubmitter`)

The `MeshSubmitter` interface is the swap point for remote execution.
v0 ships `LocalMeshSubmitter` (default — sub-agents run in new local
sessions). Implement the interface to route sub-agents elsewhere.

```ts
import { LocalMeshSubmitter, type MeshSubmitter, type SubagentInput } from "@envoymesh/envoy-harness";

class MyCustomSubmitter implements MeshSubmitter {
  async submit(input: SubagentInput) {
    // Send `input` to a remote peer, a queue, a worker pool —
    // anywhere you want sub-agents to run. Return a SubagentResult.
    return myTransport.sendAndAwait(input);
  }
  // Optional: listSubagents() for /agents in the REPL.
  // Optional: signer for the result (trust boundary).
}

const agent = new Agent({
  model, session, hooks, tools,
  meshSubmitter: new MyCustomSubmitter(),
});
```

The `task` tool's contract is the same either way; the only thing
that changes is where the sub-agent runs.

---

## Part 3: Bridge to EnvoyMesh

When you want sub-agents to route to other nodes in the mesh, install
Package 3 and swap the local submitter for a remote one.

### Install

```sh
pnpm add @envoymesh/envoy-harness-adapter
```

### Use the reference adapter

Package 3 ships `EnvoyHarnessAdapter` — the mesh-side `AgentAdapter`
contract implemented over envoy-harness. It's the reference
implementation that the mesh uses; your project can use the same code,
or write your own ~500 LoC adapter against the stable
`@envoymesh/protocol` types.

```ts
import {
  EnvoyHarnessAdapter,
  RemoteMeshSubmitter,
  defaultBuildAgent,
  defaultBuildAgentFactory,
  defaultSignResult,
  defaultCrossVerify,
} from "@envoymesh/envoy-harness-adapter";

const adapter = new EnvoyHarnessAdapter({
  buildAgent: defaultBuildAgentFactory({
    cwd: process.cwd(),
    defaultSkillId: "default",
    defaultCostCeilingUsd: 5.0,
  }),
  // Optional: signResult for trust boundary.
  signResult: defaultSignResult({ secretKey: process.env.MESH_SIGNING_KEY! }),
  // Optional: crossVerify — the adapter can run a
  // verifier on the result before returning it.
  crossVerify: defaultCrossVerify({ rules: [] }),
});
```

### Use the remote mesh submitter

The `RemoteMeshSubmitter` is a thin wrapper over
`RemoteSubmitterTransport` (a transport interface you implement —
typically libp2p, HTTP, or a queue). The `task` tool stays the same.

```ts
import { RemoteMeshSubmitter } from "@envoymesh/envoy-harness-adapter";
import { MyLibp2pTransport } from "@myorg/mesh-transport";

const meshSubmitter = new RemoteMeshSubmitter({
  transport: new MyLibp2pTransport({ /* libp2p config */ }),
});

const agent = new Agent({
  model, session, hooks, tools,
  meshSubmitter,
});

// Now `task` tool calls route to a remote peer.
const result = await agent.run("research the EnvoyMesh runbook");
// → spawns a sub-agent on whichever peer the mesh routes to.
```

The wire format is opaque to envoy-harness — Package 3 owns the
envelope, the signature, and the trust boundary. envoy-harness only
sees a `SubagentResult` come back.

### The boundary contract

> **envoy-harness is the local agent runtime. EnvoyMesh is the mesh
> fabric. The two are connected by exactly one package:
> `envoy-harness-adapter` (Package 3).**

Full contract: [`docs/boundary.en.md`](./docs/boundary.en.md).

| Layer | Owns | Does NOT own |
|---|---|---|
| **envoy-harness (Package 1)** | Local agent loop, types, built-in capabilities, `MeshSubmitter` interface, `LocalMeshSubmitter` | Mesh protocols, peer discovery, libp2p, cross-runtime adapters, mesh-state persistence |
| **envoy-harness-adapter (Package 3)** | The bridge: `EnvoyHarnessAdapter` (mesh-side contract over envoy-harness), `RemoteMeshSubmitter`, `defaultBuildAgent`, `defaultSignResult`, `defaultCrossVerify` | Anything that doesn't talk to BOTH envoy-harness and the mesh |
| **EnvoyMesh (sibling monorepo)** | Mesh fabric: libp2p, peer discovery, capability advertisement, cross-runtime adapters, Tauri UI | The local agent loop, the local type system, the local hook/tool/verifier registries |

### End-to-end flow

```
┌──────────────────────┐                ┌──────────────────────┐
│  envoy-harness       │                │  envoy-harness-      │
│  (Package 1)         │                │  adapter             │
│                      │                │  (Package 3)         │
│  Agent.run(prompt)   │                │                      │
│       │              │                │                      │
│       │ task tool    │                │                      │
│       ▼              │                │                      │
│  MeshSubmitter ─────┼── swap in ────▶│  RemoteMeshSubmitter │
│  (Local default)    │                │      │               │
│                      │                │      ▼               │
│                      │                │  RemoteSubmitter    │
│                      │                │  Transport           │
└──────────────────────┘                └──────────┬───────────┘
                                                   │
                                                   ▼
                                        ┌──────────────────────┐
                                        │  EnvoyMesh            │
                                        │  (sibling monorepo)   │
                                        │                      │
                                        │  libp2p / peer       │
                                        │  discovery / routes  │
                                        │  to remote peer      │
                                        └──────────────────────┘
```

The contract between Package 1 and Package 3 is the `MeshSubmitter`
interface + the `SubagentResult` envelope. envoy-harness never sees
the wire format; EnvoyMesh never sees the local agent loop.

---

## Where to go next

- [`docs/build-and-run.md`](./docs/build-and-run.md) — build the monorepo and run CLI / WebUI.
- [`README.md`](./README.md) — full feature surface + flags + tables.
- [`docs/design.en.md`](./docs/design.en.md) — the design doc (English, source of truth).
- [`docs/boundary.en.md`](./docs/boundary.en.md) — the package boundary contract.
- [`docs/implementation-plan.md`](./docs/implementation-plan.md) — what shipped, where it lives, what's still open.
- The MAP protocol that envoy-harness speaks is defined in `EnvoyMesh/docs/agent-network-architecture.md` (in the EnvoyMesh repo).

If you hit a rough edge, file an issue or open a PR — the
implementation plan is the single source of truth for what's open.
