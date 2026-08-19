# QuickStart

Focused how-to for `@envoymesh/envoy-harness`. Three layers, one
document:

1. **Use it** — install + one-shot + REPL + persistence.
2. **Embed it** — drop the agent loop into your own app.
3. **Bridge to EnvoyMesh** — flip the local sub-agent to remote via Package 3.

> The four design targets — EnvoyMesh-native, Independently runnable,
> Easy to integrate elsewhere, Self-contained testable — show up in all
> three layers. v0 is the first three, and `easy to integrate elsewhere`
> is what this document makes concrete.

---

## Part 1: Use it

### Install

```sh
npm install -g @envoymesh/envoy-harness
# or
pnpm add -g @envoymesh/envoy-harness
```

Set one API key (any of `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
`DEEPSEEK_API_KEY`; the first time you run without a key, the CLI
tells you which one is missing).

```sh
export ANTHROPIC_API_KEY=sk-...
```

### One-shot run

```sh
# Read a prompt, run the agent loop, print the result.
envoy "explain the auth module"

# Plan-only (no tool execution).
envoy --plan "add a /healthz endpoint to the API"

# Permission modes: read-only | workspace-write | danger-full-access
envoy --sandbox=workspace-write "refactor the auth module"

# Cost ceiling — the agent aborts when reached.
envoy --max-cost-usd=2.50 "write tests for src/auth.ts"

# Pipe a prompt from stdin.
echo "summarize the diff" | envoy -

# JSON Lines output (machine-readable; for trace viewers / `jq`).
envoy --json "explain this" | tee /tmp/envoy-trace.jsonl
```

### Interactive REPL

The REPL is the long-lived loop: one `Agent`, one `Session`, many
turns. Hooks, AGENTS.md, and permission state are preserved across
turns. 26 built-in slash commands.

```sh
envoy --repl
```

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
envoy --repl --session-dir ~/.local/state/envoy-harness/sessions --resume <id>
```

The session's history (transcript, cwd, permission mode) is restored;
the loop is the same, the slash commands are the same.

### Persistence round-trip

```sh
# 1. One-shot, save to disk.
envoy --persist "fix the bug in src/auth.ts"
# stderr: persisted session: 7c2b3e4d-...

# 2. Resume in REPL.
envoy --repl --session-dir ~/.local/state/envoy-harness/sessions --resume 7c2b3e4d-...

# 3. Fork a saved session (copy + new id, original transcript).
envoy --fork 7c2b3e4d-... "try a different approach"
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

### Sub-agents

The `task` tool spawns a sub-agent in a **new session** (own id, own
AGENTS.md, own hooks, own permission — even when local). In Package
1, sub-agents run locally; in Package 3, they're routed to a remote
peer.

```sh
# Spawn a sub-agent from the CLI.
envoy task "translate the README to zh"

# Spawn a sub-agent from the REPL.
envoy> /task research "find the EnvoyMesh runbook"
envoy> /agents                # list spawned sub-agents + their status
```

The agent's `MeshSubmitter` is the swap point: `LocalMeshSubmitter`
(default) vs `RemoteMeshSubmitter` (Package 3). The same `task` tool
call works either way.

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

- [`README.md`](./README.md) — full feature surface + flags + tables.
- [`docs/design.en.md`](./docs/design.en.md) — the design doc (English, source of truth).
- [`docs/boundary.en.md`](./docs/boundary.en.md) — the package boundary contract.
- [`docs/implementation-plan.md`](./docs/implementation-plan.md) — what shipped, where it lives, what's still open.
- The MAP protocol that envoy-harness speaks is defined in `EnvoyMesh/docs/agent-network-architecture.md` (in the EnvoyMesh repo).

If you hit a rough edge, file an issue or open a PR — the
implementation plan is the single source of truth for what's open.
