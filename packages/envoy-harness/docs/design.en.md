# envoy-harness v0 — A Design Document

> The home-team agent of EnvoyMesh. Reference implementation of the Mesh Adapter Pattern (MAP). Built for one job: **being the most production-ready CLI agent in the EnvoyMesh mesh**.
>
> Companion: [`envoy-harness-design.zh.md`](./envoy-harness-design.zh.md) (中文版, machine-translated reference; this English version is the source of truth).
>
> Sources read for this design:
> - [`../../codex`](../../codex) — production Codex CLI in Rust (`codex-rs/core/src/agents_md.rs:1-90`, `protocol/src/config_types.rs:86-96`, `protocol/src/protocol.rs:915-939`, `core/src/hook_runtime.rs:8-32`)
> - [`../../claw-code`](../../claw-code) — Claude Code Rust port with explicit 9-lane parity harness (`PARITY.md`, `rust/crates/runtime/src/permission_enforcer.rs`)
> - [`../../deepseek-harness`](../../deepseek-harness) — Cordis, formal effect tracking, capability seams
> - [`../../penguin-harness`](../../penguin-harness) — 5-step self-evolution, scoreboard, contamination guard
> - [`../../pi`](../../pi) — minimal extension model, TaggedError, Agent Skills standard
> - [`./improving-agent-network.en.md`](./improving-agent-network.en.md) — MAP protocol, 3-tuple reputation, federated scoreboard

---

## 0. How to read this document

This is a long document. Different readers need different parts.

| If you are... | Read | Then come back to |
|---|---|---|
| **A new contributor** adding a tool or permission mode | §1, §2, §5, §6, §17 (file layout), §20 (config) | §11 (adapter) when you touch MAP |
| **A reviewer** evaluating the design | §1, §2, §3, §23 (decisions) | §22 (open questions) |
| **A user** trying to understand what envoy-harness is | §1, §2 (end-to-end), §18 (CLI), §19 (config) | §13 (self-evolution) for advanced use |
| **An implementer** building v0 | All of it, in order | — |

**If you read nothing else, read §1 (the strategic position) and §2 (the end-to-end example).** These are the only two sections where reading less is harmful.

---

## 1. The strategic position

EnvoyMesh is a P2P mesh of nodes. Each node runs **one agent runtime** at a time — OpenClaw, Pi, Hermes, Codex, or in the future, **envoy-harness**. Today the EnvoyMesh team has no control over those external runtimes; their evolution is owned by their maintainers.

envoy-harness is **the home-team agent**. It is the reference implementation of the MAP protocol, and the first adapter that consumes the full envelope. It is not "the system agent" — it competes for the same tasks as every other adapter, with the same reputation rules. What it has that others do not:

- **Mesh-native execution.** Sub-agents can run on any node in the mesh. Other harnesses are local-only.
- **Federated self-evolution.** Verifier rules can be shared, opt-in, across nodes running envoy-harness. Other harnesses evolve one node at a time.
- **3-tuple reputation.** Per `(peer, runtime=envoy-harness, skillId)` track record that no other runtime can claim.

envoy-harness is built for one job: **being the most production-ready CLI agent in the EnvoyMesh mesh**. It borrows UX lessons from Codex CLI and Claude Code, discipline from DeepSeek-Harness, and self-evolution from Penguin. It speaks the MAP protocol natively — no translation layer.

> **The four design targets — non-negotiable, not negotiable tradeoffs**:
>
> 1. **EnvoyMesh-native.** envoy-harness speaks MAP natively. Sub-agents can run on any node
>    in the mesh. Federated self-evolution, 3-tuple reputation, chain-orchestrator integration
>    are first-class — not bolt-ons.
> 2. **Independently runnable.** `npm install -g @envoymesh/envoy-harness` works without
>    any mesh, any peer node, any EnvoyMesh install. A solo developer gets a production-grade
>    CLI agent out of the box.
> 3. **Easy to integrate elsewhere.** Any project that wants a "MAP-like" mesh can depend
>    on Package 1, then write a ~500 LoC Package 3 against the stable `@envoymesh/protocol`
>    contract. No fork, no rewrite, no escaping EnvoyMesh internals.
> 4. **Self-contained, fully independently testable.** Package 1's test suite passes
>    in complete isolation: no mesh, no peer, no network, no `libp2p` daemon, no
>    EnvoyMesh install, no live LLM key required. Mock LLM, mock adapter, mock verifier.
>    CI runs the suite on every commit in a sandbox; the harness is the system under
>    test, nothing else. **If a test needs a real mesh, it belongs in Package 3's suite,
>    not here.** This is what makes envoy-harness usable as a library in other projects.
>
> These four are checked at every design decision. A feature that improves one at the cost
> of another does not ship. When in doubt, target 4 (testability) wins, because the other
> three depend on it.
>
> **Predecessor doc (load-bearing contract)**: this design follows the contracts defined in
> `envoymesh-design/improving-agent-network.{en,zh}.md`. Every wire-level detail comes from
> that document and is **not redefined here**:
>
> - `AgentAdapter` interface (§5.1)
> - `CapabilityManifest` / `AgentResult` / `Verdict` schemas (§4)
> - `AgentRuntime` enum — envoy-harness is the first runtime value whose adapter is canonical
>   rather than sketched
> - 3-tuple reputation key shape `(peer, runtime=envoy-harness, skillId)` (§7)
> - `CompositeVerifier` rule combination: OR-of-pass, AND-of-fail, default disputed (§6.2)
> - Cross-agent verification flow: two-doctor pattern (§8)
> - Federated self-evolution: local scoreboard + opt-in federation (§9)
> - Adapter contract: owner-key-signed envelopes, not adapter-key-signed
>
> Where this document and the predecessor disagree, **the predecessor wins for wire details**;
> this document is authoritative for envoy-harness's internal shape (permissions, hooks,
> AGENTS.md, verifier rule set, agent loop, CLI). The two are designed to be read together;
> a reader of one without the other will miss half the picture.

### 1.1 What envoy-harness is NOT

- **Not a replacement** for OpenClaw, Pi, Hermes, or Codex. They stay supported.
- **Not "the system agent"** that gets privileged access. It competes for tasks the same way every other adapter does.
- **Not a wrapper.** envoy-harness is a fresh implementation, not a thin shim over an existing tool.
- **Not locked to a single model provider.** envoy-harness ships with multi-provider support from day 1; Anthropic, OpenAI, Ollama, and custom endpoints are first-class.
- **Not a UI application.** envoy-harness is a CLI. Web UIs and IDE integrations are separate consumers that may use envoy-harness as a library.
- **Not tied to EnvoyMesh.** envoy-harness ships as a standalone package (`@envoymesh/envoy-harness`). The EnvoyMesh mesh integration is a separate, optional adapter package. Other projects can adopt envoy-harness directly, without EnvoyMesh.

### 1.2 What envoy-harness uniquely enables

Three capabilities that no other agent harness provides today:

1. **A agent that is the first consumer of every EnvoyMesh feature.** When MAP adds a new field, envoy-harness uses it. When the chain orchestrator grows a new sub-step, envoy-harness runs it. The home-team agent is always at the leading edge of the mesh.
2. **A self-evolution discipline that is auditable, not magic.** Every change to the verifier ruleset goes through a 5-step protocol with owner-key-signed scoreboard entries. The optimizer never sees the rubric.
3. **A reputation system that is forkable.** A node running envoy-harness accumulates `(peer, runtime=envoy-harness, skillId)` reputation that other nodes can read and trust. This reputation is unusable by other runtimes — it is envoy-harness's competitive moat.

### 1.3 Repository strategy (independent first, integrate later)

envoy-harness is built as a **standalone npm package** that happens to have an optional EnvoyMesh integration. The pattern follows Codex CLI (npm-installable, OpenAI infra separate) and Claude Code (npm-installable, Anthropic API separate). The CLI is a user-facing product; the mesh is a separate concern.

#### 1.3.1 The three packages

```
Package 1: @envoymesh/envoy-harness
  Lives: in its own repo, or in EnvoyMesh's monorepo under strict package isolation
  Depends on: nothing EnvoyMesh-internal
  Published: yes — npm install -g @envoymesh/envoy-harness
  Ships: cli, hooks, AGENTS.md, verifier, 5-step self-evolution, local tools
  Tested: without a mesh; mock LLM; mock adapters
  Users: developers, CI pipelines, anyone who wants a CLI agent

Package 2: @envoymesh/protocol
  Lives: EnvoyMesh's monorepo
  Published: yes — versioned, contract-stable
  Contains: AgentAdapter interface, manifest/result/verdict schemas
  Both envoy-harness and EnvoyMesh depend on it
  This is the *contract* between them

Package 3: @envoymesh/envoy-harness-adapter
  Lives: EnvoyMesh's monorepo
  Depends on: envoy-harness + protocol + libp2p + EnvoyMesh internals
  Size: ~500 LoC
  Contains: the bridge — implements AgentAdapter for envoy-harness
  Does: broadcasts manifest to mesh, submits tasks to chain orchestrator,
        reads verdicts from ArbitrationStore
  Tested: against both envoy-harness and EnvoyMesh, with mocks
  Only envoy-harness code that knows the mesh exists
```

#### 1.3.2 What this buys

- **Independent ship cadence.** envoy-harness can release on its own schedule. EnvoyMesh doesn't gate envoy-harness's progress.
- **No mesh required.** A user can `npm install -g @envoymesh/envoy-harness` and use it locally without ever running EnvoyMesh.
- **Other projects adopt envoy-harness.** Code-server, IDEs, CI pipelines, or a hypothetical "XMesh" can use envoy-harness by depending on Package 1, optionally writing their own Package 3 equivalent.
- **Mock-based testing.** envoy-harness tests run against a mock adapter; EnvoyMesh tests run against a mock adapter; the real adapter is the only thing that touches both.
- **Failure isolation.** If EnvoyMesh development stalls, envoy-harness continues. If envoy-harness has a bug, EnvoyMesh is unaffected.

#### 1.3.3 What this costs

- **One more contract to maintain.** `@envoymesh/protocol` becomes a published, versioned package. Breaking changes are a coordination cost.
- **Two CIs, two release processes.** envoy-harness and EnvoyMesh each have their own. The adapter sits in EnvoyMesh's CI.
- **Risk of API drift.** If envoy-harness adds a new method to `AgentAdapter` and EnvoyMesh is slow to consume, the contract is broken. Mitigation: the contract has tests in *both* repos; both must pass before either releases.

#### 1.3.4 What does NOT change

- **The MAP protocol itself** (`@envoymesh/protocol`). Already designed for stable contract.
- **The AgentAdapter interface**. It is the single seam; both sides implement against it.
- **The 3-tuple reputation keys**. `(peer, runtime=envoy-harness, skillId)` is the format envoy-harness writes; other runtimes write their own keys.
- **The scoreboard format**. `verifier-scoreboard.yaml` is envoy-harness's; EnvoyMesh doesn't read it.

#### 1.3.5 Release timeline under this strategy

```
Month 1-2:  envoy-harness ships standalone (Package 1, no mesh integration)
            ↓ users can `npm install -g @envoymesh/envoy-harness` and use it
Month 3:    @envoymesh/protocol is stable and published (Package 2)
            envoy-harness depends on Package 2 (its manifest/verdict types)
Month 4:    @envoymesh/envoy-harness-adapter (Package 3) ships in EnvoyMesh
            installing it: envoy-harness can broadcast manifests via libp2p
Month 5+:   envoy-harness and EnvoyMesh iterate independently
            adapter tracks protocol's minor versions
```

**Key advantage**: by Month 2, envoy-harness is in users' hands. The mesh integration is a *progressive enhancement*, not a *prerequisite*.

---

## 2. End-to-end example

Before any design detail, here is one user story that exercises the whole system. Use it to anchor everything that follows.

### 2.1 The user story

Alice is a backend engineer. Her node runs envoy-harness (the default; she has not configured otherwise). She starts a session in her project root, which is a git repo with two AGENTS.md files — one at the project root, one in `services/auth/`.

```
~/work/payments/    ← cwd (project root, .git present)
├── AGENTS.md       ← "always run tests before commit"
├── services/
│   ├── auth/
│   │   ├── AGENTS.md  ← "this service uses jose for JWTs"
│   │   └── src/auth.ts
│   └── payments/
│       └── src/charge.ts
```

She runs:

```
envoy "refactor the auth module to use jose instead of jsonwebtoken, and add a test for the new token shape"
```

### 2.2 What happens, step by step

```
1. argv parsing (cli.ts)
   - --sandbox (default read-only)
   - --approval (default on-request)
   - --cwd (default process.cwd)
   → construct a SessionConfig

2. AGENTS.md discovery (agents-md/discover.ts)
   - findProjectRoot("~/work/payments", [".git"]) → "~/work/payments"
   - collectDocPaths(projectRoot, cwd, ["AGENTS.md"])
     → ["~/work/payments/AGENTS.md", "~/work/payments/services/auth/AGENTS.md"]
   - read each, respecting 32 KB budget
   - check for AGENTS.override.md at cwd → not present
   → LoadedAgentsMd with two project docs, 1.2 KB total

3. config load (config/loader.ts)
   - read $ENVOY_HOME/agent-state/<peer>/config.toml
   - parse TOML with Zod schemas
   - resolve profile (none configured → use inline config)
   - validate: permission_mode=read-only, ask_for_approval=on-request
   → ResolvedConfig

4. permission resolution (permissions/mode.ts)
   - mode = read-only
   - approval = on-request
   - backend = auto-detect → linux-landlock
   - writable_roots = [] (cwd only when in workspace-write; we're in read-only)
   → SandboxPolicy

5. hook setup (hooks/registry.ts)
   - read $ENVOY_HOME/agent-state/<peer>/hooks.toml
   - register handlers for each event
   - load 12 default empty handlers
   → HookRegistry

6. session start (session.ts)
   - state = LOADING
   - emit SessionStart hook
   - initialize cost tracker
   - state = ACTIVE
   → Session

7. turn loop (agent.ts)
   loop:
     7a. build context:
         - load AGENTS.md (from step 2)
         - load session history
         - call transformContext (prune + inject)
         - call convertToLlm (filter to LLM-visible messages)
     7b. call model with current context
     7c. for each event from model:
         - text_delta → append assistant/chunk
         - tool_call → fire PreToolUse hook → check permissions → execute → fire PostToolUse hook
         - tool_result → append, continue
     7d. if model emits tool_calls that violate read-only → block (PreToolUse returns block)
     7e. end of stream? → turn ends
     7f. more work? → next turn

8. bash tool call: "git checkout -b refactor/jose-auth"
   - PreToolUse hook fires: hooks.PreToolUse match=bash runs "echo $TOOL_CALL >> audit.log"
   - permission check:
     * PermissionMode=read-only
     * bash validators: readOnlyValidation sees "git checkout" → no write pattern → allow
   - executes: git checkout
   - PostToolUse hook fires

9. write tool call: rewrite services/auth/src/auth.ts
   - PreToolUse hook fires
   - permission check:
     * PermissionMode=read-only
     * bash validators: readOnlyValidation sees write pattern → block, reason="read-only mode cannot write"
   - tool result returned to model: "BLOCKED: read-only mode cannot write"
   - PreToolUse hook (PreCompact? no) and we move to ask the user

10. AskForApproval=on-request → model emits "I need to switch to workspace-write"
    → UI prompt: "Allow workspace-write mode for this session? [y/n]"
    → user accepts
    → session config updated: permission_mode=workspace-write
    → state continues, no session restart

11. write tool call now succeeds
    → PreToolUse hook fires
    → permission check: readOnlyValidation passes (we're now workspace-write)
    → pathValidation: services/auth/src/auth.ts is under cwd → allow
    → write tool writes the file
    → PostToolUse hook fires, mtime recorded

12. bash tool call: "npm test"
    → same flow: permission check, validators pass, executes

13. end of turn: assistant emits final summary
    → append assistant/message to session log
    → emit Stop hook
    → state = STOPPED (or COMPLETED, depending on if model thinks it's done)

14. session end
    → emit SessionEnd hook
    → persist session log to $ENVOY_HOME/sessions/<id>.jsonl
    → cost report: "1.2K prompt + 800 completion tokens, $0.04, 4 turns, 3 tool calls"
```

### 2.3 What goes into the mesh

In this example, **nothing** goes into the mesh. Alice's session runs entirely on her own node. envoy-harness only touches the mesh if Alice runs `envoy task "..."` to spawn a sub-agent. That's the next example.

### 2.4 Mesh-native sub-agent example

Alice's task grew: "also update the gateway to use the new auth client, and check the docs are still right". She runs:

```
envoy task "search all docs for references to the old jsonwebtoken API; list them"
```

This becomes:

```
1. envoy task subcommand parses the input
2. TaskInput constructed:
   - objective: "search all docs for references to the old jsonwebtoken API; list them"
   - capabilityTag: "code-search"
   - costCeilingUsd: 1.00
   - deadlineMs: 60000
3. mesh/chain-submit.ts:
   - build a ChainSubtask from the TaskInput
   - sign it with the node's owner key
   - broadcast task.propose to bonded peers
4. orchestrator on another node (Bob's, which runs OpenClaw) bids
5. orchestrator accepts; the chain step runs on Bob's node
6. Bob's node returns a SignedAgentResult
7. envoy-harness's Task tool receives the result
8. cross-adapter verifier: envoy-harness's own rules + (optional) cross-agent comparison
9. result is appended to Alice's session
```

In this case, the work ran on a different node, with a different agent, **but the verification, cost accounting, and audit trail stayed on Alice's envoy-harness node**. That's mesh-native sub-agents.

### 2.5 Self-evolution example (later)

After running 50 such tasks, envoy-harness has enough verdicts in the local scoreboard. Alice runs:

```
envoy self-evolve
```

This triggers the 5-step protocol:

```
1. SNAPSHOT    — copy current verifier-rules.json to /snapshots/v<n>.json
2. HYPOTHESIZE — model: "I see 8/50 false-pass on bash tasks because pathValidation
                  lets ../ escape cwd. Tighten the regex."
3. CANDIDATE   — write the candidate ruleset to /candidate/v<n>.json
4. EVALUATE    — re-run 50 tasks with the candidate
5. COMMIT      — pass rate improved (0.84 → 0.92) → owner signs scoreboard entry,
                  commit candidate to verifier-rules.json
                — or REVERT — pass rate same or worse → restore snapshot
```

The user sees one new entry in `$ENVOY_HOME/agent-state/<peer>/verifier-scoreboard.yaml`, signed by her owner key.

---

## 3. The runtime core

This section describes the parts that *run*. Everything else is data these parts operate on.

### 3.1 The Agent class

The `Agent` is the long-lived per-node object. There is one Agent per node. It holds:

- The `Models` registry (provider + model pair).
- The `ManifestBuilder` (signs and broadcasts the CapabilityManifest).
- The `SessionStore` (in-memory map of active Session instances).
- The `ReputationBook3Tuple` (local view of `(peer, runtime, skillId)` scores).
- The `CostTracker` (per-session spend accumulator).
- The `McpClientRegistry` (long-lived MCP client connections).
- The `HookRegistry` (the registry from §8).

The Agent does **not** contain the agent loop. The agent loop lives in `Session` (one per active session).

```ts
// src/agent.ts (sketch)
export class Agent {
  readonly peerId: string
  readonly ownerId: string
  readonly models: Models
  readonly hookRegistry: HookRegistry
  readonly mcpClients: McpClientRegistry
  readonly reputation: ReputationBook3Tuple
  readonly costTracker: CostTracker
  private readonly sessions = new Map<SessionId, Session>()

  constructor(public readonly config: ResolvedConfig) {
    // ... init above
  }

  /**
   * One per session. The session is the unit of conversation;
   * the agent is the long-lived runtime.
   */
  async createSession(input: CreateSessionInput): Promise<Session> {
    const session = new Session({
      agent: this,
      cwd: input.cwd ?? process.cwd(),
      sandboxPolicy: this.config.sandbox,
      mode: input.mode ?? this.config.permissionMode,
      approval: input.approval ?? this.config.askForApproval,
      agentsMd: input.agentsMd ?? await this.loadAgentsMd(input.cwd),
    })
    this.sessions.set(session.id, session)
    return session
  }

  async resumeSession(id: SessionId): Promise<Session> { /* ... */ }
  async forkSession(id: SessionId, atBoundary: EntryId): Promise<Session> { /* ... */ }

  /**
   * CapabilityManifest broadcast. Signed by owner key.
   * Runs on a timer (default every 150s) and on demand.
   */
  async broadcastManifest(): Promise<SignedCapabilityManifest> { /* ... */ }
}
```

### 3.2 The Session class

A `Session` is one conversation. It has a state machine (see §3.3) and an agent loop (see §3.4). Sessions are independent of each other; one node can have many active sessions, each with its own permission mode and approval setting.

```ts
// src/session.ts (sketch)
export class Session {
  readonly id: SessionId  // generated UUID
  readonly agent: Agent
  readonly cwd: string
  state: SessionState
  private messages: AgentMessage[]  // the conversation
  private readonly hookContext: HookContext

  constructor(public readonly input: SessionInput) {
    this.state = 'loading'
  }

  /**
   * Run a single prompt through the agent loop. Streams events.
   * If the session is in plan mode, this is read-only.
   */
  async *run(prompt: string | AgentMessage, opts: RunOptions): AsyncIterable<SessionEvent> {
    // ... see §3.4
  }

  /**
   * User asked to compact. Compress the conversation history.
   * Fires PreCompact and PostCompact hooks.
   */
  async compact(): Promise<void> { /* ... */ }

  /**
   * Re-read all config, hooks, AGENTS.md. Does not interrupt the current turn.
   */
  async reload(): Promise<void> { /* ... */ }

  /**
   * Persist the current state. Atomic write to disk.
   */
  async persist(): Promise<void> { /* ... */ }
}
```

### 3.3 The Session state machine

```
                      create
                         │
                         ▼
        ┌────────────── LOADING ──────────────┐
        │ • discover AGENTS.md                  │
        │ • load config                         │
        │ • register hooks                      │
        │ • spawn manifest broadcast            │
                         │
                  session_start fires
                         │
                         ▼
        ┌──────────── ACTIVE ──────────────────┐
        │ • run() is callable                   │
        │ • user can interact                   │
        │ • events stream to UI                 │
        │                                      │
        │  ┌── turn loop running ──┐           │
        │  │ • model call          │           │
        │  │ • tool calls          │           │
        │  │ • hooks fire          │           │
        │  └────────────────────────┘           │
        │                                      │
        │   on /reload ──────► RELOADING       │
        │   on /compact ────► COMPACTING       │
        │   on cancel ──────► CANCELLING       │
        │   on error ───────► FAILED           │
        │   on completion ───► CLOSING          │
        │                                      │
        └──────────────────────────────────────┘
                         │
                  session_end fires
                         │
                         ▼
        ┌──────────── CLOSED ──────────────────┐
        │ • session log persisted               │
        │ • cost report printed                 │
        │ • hooks deregistered                  │
        │ • session is gone from memory         │
        │ • can be resumed from disk            │
        └──────────────────────────────────────┘
```

The states are exhaustively: `loading | active | reloading | compacting | cancelling | failed | closing | closed`. Each transition fires a hook (`SessionStart`, `Stop`, `SubagentStop`, `SessionEnd`, etc.) so user-defined hooks can react to state changes.

### 3.4 The agent loop (the turn)

The turn loop is what `session.run()` does. It is the actual heart of the agent.

```ts
// src/agent.ts (the loop)
async function* runTurn(session: Session, prompt: AgentMessage, opts: RunOptions): AsyncIterable<SessionEvent> {
  // 1. Append the user's message.
  session.appendMessage(prompt)
  yield { kind: 'user_message_appended', message: prompt }

  // 2. Loop until the model emits no more tool calls.
  let turnContinues = true
  while (turnContinues) {
    // 2a. Build the LLM context.
    const contextMessages = session.messages
    const llmMessages = convertToLlm(contextMessages, session.agent.config.llmFilter)

    // 2b. Emit turn_start.
    yield { kind: 'turn_start' }

    // 2c. Fire PreCompact hook if context is over budget.
    if (estimateContextSize(llmMessages) > session.config.maxContextTokens * 0.8) {
      const decision = await session.hookRegistry.fire('PreCompact', { session, messages: llmMessages })
      if (decision.kind === 'block') {
        yield { kind: 'turn_aborted', reason: 'pre-compact blocked' }
        return
      }
    }

    // 2d. Call the model.
    let assistantMessage: AssistantMessage | null = null
    let toolCalls: ToolCall[] = []
    for await (const event of callModel(llmMessages, session.model, session.signal)) {
      if (event.kind === 'text_delta') {
        yield { kind: 'assistant_text_delta', delta: event.delta }
      } else if (event.kind === 'tool_call') {
        toolCalls.push(event.toolCall)
      } else if (event.kind === 'final') {
        assistantMessage = event.assistantMessage
      }
    }
    if (assistantMessage) session.appendMessage(assistantMessage)
    yield { kind: 'assistant_message', message: assistantMessage }

    // 2e. If no tool calls, the turn is done.
    if (toolCalls.length === 0) {
      turnContinues = false
      break
    }

    // 2f. Execute each tool call (sequentially for v0; parallel later).
    for (const tc of toolCalls) {
      // Fire PreToolUse hook. Hook may block, modify input, or add context.
      const preDecision = await session.hookRegistry.fire('PreToolUse', { tool: tc.name, input: tc.input })
      if (preDecision.kind === 'block') {
        session.appendMessage({ kind: 'tool_result', toolCallId: tc.id, content: 'BLOCKED: ' + preDecision.reason, isError: true })
        yield { kind: 'tool_blocked', toolCall: tc, reason: preDecision.reason }
        continue
      }
      const inputToUse = preDecision.kind === 'modify' ? preDecision.modified : tc.input

      // Permission enforcement (separate from hooks; both run).
      const permDecision = await session.permissionEnforcer.check(tc.name, inputToUse)
      if (permDecision.kind === 'deny') {
        session.appendMessage({ kind: 'tool_result', toolCallId: tc.id, content: 'DENIED: ' + permDecision.reason, isError: true })
        yield { kind: 'tool_denied', toolCall: tc, reason: permDecision.reason }
        continue
      }
      if (permDecision.kind === 'ask') {
        // AskForApproval=on-request path: prompt the user.
        const userDecision = await session.askUser({ tool: tc.name, input: inputToUse, reason: permDecision.reason })
        if (userDecision.kind === 'deny') {
          session.appendMessage({ kind: 'tool_result', toolCallId: tc.id, content: 'DENIED BY USER', isError: true })
          yield { kind: 'tool_denied_by_user', toolCall: tc }
          continue
        }
      }

      // Execute.
      let result: ToolResult
      try {
        result = await session.executeTool(tc.name, inputToUse, session.signal)
      } catch (err) {
        result = { kind: 'error', content: err.message, isError: true }
      }
      session.appendMessage({ kind: 'tool_result', toolCallId: tc.id, ...result })
      yield { kind: 'tool_result', toolCall: tc, result }

      // Fire PostToolUse hook (may modify result).
      const postDecision = await session.hookRegistry.fire('PostToolUse', { tool: tc.name, input: inputToUse, result })
      if (postDecision.kind === 'modify') {
        // Replace the tool_result in messages.
        session.replaceLastToolResult(postDecision.modified)
      }
    }

    // 2g. Update cost tracker.
    session.costTracker.recordTurn({ ... })

    // 2h. Decide whether to continue.
    turnContinues = !session.shouldStop()
  }

  // 3. Emit turn_end and Stop.
  yield { kind: 'turn_end' }
  await session.hookRegistry.fire('Stop', { session })
}
```

**This is the runtime.** Every other section in this document describes the data this loop reads and writes.

**Key invariants enforced by the loop**:

- The user's message is appended before the model call (model sees it).
- The assistant's message is appended after the model finishes.
- Every tool call has a corresponding tool_result in the message log.
- Hooks run in the correct order: PreToolUse → permission check → execute → PostToolUse.
- If a tool is blocked or denied, the model gets a `tool_result` explaining why (it can react).
- Cost is recorded per turn, not per session end.

### 3.5 Tool execution

Each tool has a typed input schema, an execute function, and a known permission requirement. The `executeTool` function dispatches:

```ts
// src/tools/registry.ts (sketch)
export interface ToolDefinition<TInput, TOutput> {
  name: string
  description: string
  inputSchema: ZodSchema<TInput>
  outputSchema: ZodSchema<TOutput>
  /** What permission mode is required at minimum. */
  requires: PermissionMode
  /** Cost in USD per call. 0 for read-only tools. */
  costUsd: number
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<any, any>>()

  register<TI, TO>(tool: ToolDefinition<TI, TO>): void { /* ... */ }

  get(name: string): ToolDefinition<any, any> | undefined { /* ... */ }

  /**
   * Dispatch. Validates input against the tool's schema first.
   * Returns either the typed output or a typed error.
   */
  async dispatch(name: string, input: unknown, ctx: ToolContext): Promise<ToolDispatchResult> {
    const tool = this.tools.get(name)
    if (!tool) return { kind: 'unknown_tool', name }
    const parsed = tool.inputSchema.safeParse(input)
    if (!parsed.success) return { kind: 'invalid_input', errors: parsed.error.errors }
    try {
      const output = await tool.execute(parsed.data, ctx)
      return { kind: 'ok', output }
    } catch (err) {
      return { kind: 'error', message: (err as Error).message, stack: (err as Error).stack }
    }
  }
}
```

**Tools never throw across the dispatch boundary.** A tool that fails returns `{ kind: 'error', ... }`; the loop appends a `tool_result` with `isError: true`. This is the only way tool errors enter the conversation — the model sees them as text, just like any other result.

---

## 4. Architectural invariants (the non-negotiables)

Each invariant comes from a specific failure mode in the wild. Each is checked by a specific test.

1. **Default is read-only.** `SandboxMode::ReadOnly` is the default. `WorkspaceWrite` is opt-in per session. `DangerFullAccess` requires an owner-key-signed escape hatch. Reason: shipping with "default can write" creates irreversible expectations.

2. **Permission and approval are separate axes.** `PermissionMode` (3 levels: read-only, workspace-write, danger-full-access) controls *what the agent can do*; `AskForApproval` (4 levels: unless-trusted, on-request, granular, never) controls *when the user is asked*. Combining them gives 12 distinct states. Reason: collapsing them creates holes.

3. **AGENTS.md discovery is up + concatenate, not first-found.** Walk from cwd to the nearest ancestor with a project-root marker (default `.git`), collecting every AGENTS.md. Concatenate in order. Stop at the marker. Reason: monorepos and nested projects have multiple AGENTS.md.

4. **`AGENTS.override.md` is a local override.** Discovered alongside AGENTS.md. The user can override the assembled doc without touching the source files. Reason: changes to a team's AGENTS.md should be reviewed, not silently overridden by local state.

5. **`project_doc_max_bytes` budget.** Hard cap on AGENTS.md total size (default 32 KB). Reason: a 1MB AGENTS.md burns the entire context window before the user's prompt is read.

6. **Hooks are 12 events, all with `pre` / `post` semantics.** PreToolUse, PostToolUse, PreCompact, PostCompact, SessionStart, SessionEnd, Stop, SubagentStop, UserPromptSubmit, Notification, PermissionRequest, Setup. (Names match Codex for mental-model portability.) Reason: hook systems grow ad-hoc; a fixed set is auditable.

7. **Bash has 6 validators, not "user said yes = ok".** `readOnlyValidation`, `destructiveCommandWarning`, `modeValidation`, `sedValidation`, `pathValidation`, `commandSemantics`. All six run on every bash call. None of them is optional. The composition is the security story, not any one of them. Reason: bash is the most common source of agent accidents; permission UX alone is not enough.

8. **MCP is bidirectional.** envoy-harness is both an MCP client (consumes other people's servers) and an MCP server (its tools are exposed to other MCP clients). Reason: network effects — every user of any agent tool becomes a potential envoy-harness user.

9. **Sub-agents map to mesh chain steps, not in-process tasks.** The Task tool spawns a sub-agent by submitting a chain step to the mesh orchestrator. The sub-agent may run on the local node or on a remote node. Reason: a mesh-native agent should not pretend the mesh doesn't exist.

10. **The AGENTS.md and the verifier ruleset are the self-evolution targets.** envoy-harness runs the 5-step protocol (Penguin-style) over both. The optimizer sees scoreboard + failed-task descriptions; the rubric stays owner-only. Reason: self-evolution is opt-in, owner-controlled, peer-auditable.

11. **Tools never throw across the dispatch boundary.** Every tool returns a `ToolDispatchResult` discriminated union. The agent loop converts to a `tool_result` with `isError: true` on error. Reason: error visibility in the model context is the only error UX that works.

12. **Cost is tracked per turn, not per session end.** Each turn increments the cost tracker immediately after the model call. Reason: the user should see cost growing, not learn about it after.

13. **Owner keys sign everything cross-node.** Manifests, results, verdicts, scoreboard entries, chain steps. The owner key is the trust anchor. Reason: signatures are the only thing verifiable across nodes without a pre-shared secret.

---

## 5. Type system (the surface every module speaks)

These are the core types. All live in `packages/envoy-harness/src/types.ts`. They mirror Codex's naming because the parity is a feature: a user migrating from Codex expects the same names.

### 5.1 Permission and approval (two axes)

```ts
import { z } from 'zod'

/**
 * What the agent can do. Maps to OS-level capability.
 * 3 levels, in increasing privilege.
 */
export const PermissionModeSchema = z.enum([
  'read-only',         // Default. Read files, network, no writes.
  'workspace-write',   // Write inside cwd (and explicit writable_roots).
  'danger-full-access',// All writes, all network. Owner-key-signed escape hatch.
])
export type PermissionMode = z.infer<typeof PermissionModeSchema>

/**
 * When the user is asked. 4 levels.
 *
 * `unless-trusted` is the strict mode: only commands that pass `is_safe_command()`
 * AND only read files are auto-approved. Everything else prompts.
 *
 * `on-request` is the default. The model decides when to ask.
 *
 * `granular` is a structured alternative: per-tool on/off via config.
 *
 * `never` is for unattended operation: never escalate, fail-closed.
 */
export const AskForApprovalSchema = z.enum([
  'unless-trusted',
  'on-request',
  'granular',
  'never',
])
export type AskForApproval = z.infer<typeof AskForApprovalSchema>

/**
 * A named profile, loaded from $ENVOY_HOME/<name>.config.toml.
 * Built-in profiles: 'read-only', 'workspace-write', 'danger-full-access'.
 * Users can override any of them, or add their own.
 */
export const PermissionProfileNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
export type PermissionProfileName = z.infer<typeof PermissionProfileNameSchema>
```

**Why the axes are separate**: a user might want `PermissionMode=read-only` and `AskForApproval=never` (no point asking if you can't write). Or `PermissionMode=workspace-write` and `AskForApproval=unless-trusted` (only auto-approve known-safe). Conflating them forces 3×4 = 12 (or 3) choices; the user wants all 12.

### 5.2 Sandbox

```ts
/**
 * Concrete sandbox backends. envoy-harness ships with `linux-landlock`
 * (Linux-only, OS-level syscall filter) and `process-fs-namespace`
 * (POSIX-only, mount namespace). Other backends are opt-in.
 */
export const SandboxBackendSchema = z.enum([
  'linux-landlock',
  'process-fs-namespace',
  'none',  // PermissionMode=DangerFullAccess only
])
export type SandboxBackend = z.infer<typeof SandboxBackendSchema>

/**
 * Combined sandbox policy. Resolved at session start from
 * PermissionMode + AskForApproval + SandboxBackend + writable_roots.
 */
export interface SandboxPolicy {
  mode: PermissionMode
  approval: AskForApproval
  backend: SandboxBackend
  /** Paths writable in workspace-write mode. Empty = cwd only. */
  writableRoots: ReadonlyArray<string>
  /** If true, network access is allowed in workspace-write mode. */
  networkAccess: boolean
  /** If true, /tmp is also writable (default true). */
  excludeSlashTmp: boolean
}
```

### 5.3 Bash validators (the 6 submodule names)

```ts
/**
 * Each validator is a function from (command, argv, env, policy) -> Verdict.
 * They run in order; any Verdict::fail short-circuits.
 */
export interface BashValidator {
  readonly name: string
  validate(input: BashValidationInput): Promise<BashVerdict>
}

export type BashVerdict =
  | { kind: 'allow' }
  | { kind: 'allow-with-warning', warning: string }  // proceed, but show the warning
  | { kind: 'block', reason: string }
```

The 6 validators (names from `claw-code/PARITY.md:67`):

1. `readOnlyValidation` — read-only mode and the command writes. Block.
2. `destructiveCommandWarning` — `rm -rf /`, `dd if=...`, etc. Allow with warning or block.
3. `modeValidation` — current mode vs command requirements.
4. `sedValidation` — `sed -i` in-place edits to system files. Block.
5. `pathValidation` — command touches paths outside writable_roots. Block.
6. `commandSemantics` — syntactically correct, no shell injection patterns.

**This is the bash safety spine.** All six run on every bash call. None of them is optional. The composition is the security story, not any one of them.

### 5.4 Hook events (the 12 names)

```ts
export const HookEventNameSchema = z.enum([
  'PreToolUse',         // before a tool call
  'PostToolUse',        // after a tool call
  'PreCompact',         // before context compaction
  'PostCompact',        // after context compaction
  'SessionStart',       // session begins
  'SessionEnd',         // session ends
  'Stop',               // main agent stops (user can intervene)
  'SubagentStop',       // a sub-agent stops
  'UserPromptSubmit',   // user submits a message
  'Notification',       // permission request, idle timeout, etc.
  'PermissionRequest',  // a permission decision is needed
  'Setup',              // initial setup hooks (run once)
])
export type HookEventName = z.infer<typeof HookEventNameSchema>

/**
 * A hook handler. May be a shell command (string) or a TS module (path).
 * Multiple handlers per event run in registration order.
 */
export interface HookHandler {
  match?: { tool?: string; pattern?: string }  // filter by tool name or pattern
  command?: string                              // shell command, $TOOL_CALL is interpolated
  module?: string                               // path to TS module, exports default HookFn
  timeoutMs?: number
}

export type HookFn = (event: HookEvent) => Promise<HookDecision>

export type HookDecision =
  | { kind: 'continue' }
  | { kind: 'modify', modified: unknown }  // PostToolUse only
  | { kind: 'block', reason: string }       // PreToolUse / PermissionRequest
  | { kind: 'add-context', content: string } // SessionStart / PreCompact
```

### 5.5 AGENTS.md

```ts
export const AGENTS_MD_FILENAME = 'AGENTS.md'
export const AGENTS_OVERRIDE_FILENAME = 'AGENTS.override.md'

/**
 * One discovered AGENTS.md. May be from the user, the project, or a local override.
 */
export interface DiscoveredAgentsDoc {
  /** Absolute path. */
  path: string
  /** File contents. */
  contents: string
  /** Origin: 'user' (~/...), 'project' (cwd-relative), or 'override' (local). */
  origin: 'user' | 'project' | 'override'
  /** Bytes; used for the budget check. */
  byteLength: number
}

/**
 * The full assembled set, in concat order. Order is:
 *   1. user instructions (from settings or env)
 *   2. project docs (cwd upward, each AGENTS.md)
 *   3. project override (AGENTS.override.md, takes precedence on conflicts)
 *
 * Concatenated with a separator. Mirrors codex-rs/core/src/agents_md.rs:43.
 */
export interface LoadedAgentsMd {
  entries: ReadonlyArray<DiscoveredAgentsDoc>
  totalBytes: number
  /** Concatenated, ready to inject into the system prompt. */
  assembled: string
}

export const DEFAULT_PROJECT_ROOT_MARKERS = ['.git']
export const DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024  // 32 KB
```

### 5.6 Verdict (the verifier result)

`Verdict` and friends live in the MAP protocol (`packages/protocol/src/agent-adapter.ts`). Re-inlined here for completeness:

```ts
export const VerdictSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pass'),
    score: z.number().min(0).max(1),
    confidence: z.enum(['low', 'medium', 'high']).default('medium'),
    notes: z.string().optional(),
  }),
  z.object({
    kind: z.literal('partial'),
    score: z.number().min(0).max(1),
    reason: z.string(),
    usableBlocks: z.array(z.number().int().nonnegative()).optional(),
  }),
  z.object({
    kind: z.literal('fail'),
    reason: z.string(),
    rollback: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('disputed'),
    needsHuman: z.literal(true),
    signals: z.array(z.string()),
  }),
])
export type Verdict = z.infer<typeof VerdictSchema>

export const VerifierSourceSchema = z.enum(['rule', 'llm', 'human', 'cross'])
export type VerifierSource = z.infer<typeof VerifierSourceSchema>

export const VerdictEntrySchema = z.object({
  chainId: z.string(),
  subtaskId: z.string(),
  workerPeerId: z.string(),
  workerRuntime: AgentRuntimeSchema,
  skillId: SkillIdSchema,
  verdict: VerdictSchema,
  source: VerifierSourceSchema,
  verifierModel: z.string().optional(),
  verifierOwnerId: z.string().optional(),
  issuedBy: z.string(),
  issuedAt: z.string().datetime(),
  signature: z.string(),
})
export type VerdictEntry = z.infer<typeof VerdictEntrySchema>
```

envoy-harness implements `VerifierSource: 'rule'` for cheap checks; `'llm'` for the verifier LLM (an owner-configured cheaper model than the worker); `'cross'` for cross-adapter agreement. `'human'` is reserved for when the user is escalated to.

### 5.7 Sub-agent (mesh-native)

```ts
/**
 * The Task tool's input. Translated by envoy-harness into a chain step
 * and submitted to the mesh orchestrator.
 */
export interface TaskInput {
  /** Plain-language description of the sub-task. */
  objective: string
  /** Required capability. Maps to MeshAdapter Manifest. */
  capabilityTag: string
  /** Cost ceiling (USD). Maps to ChainBudgetLedger.reserve. */
  costCeilingUsd: number
  /** Deadline (ms). Maps to chain orchestrator's timeout. */
  deadlineMs: number
  /** Optional: pin to a specific peer (otherwise the orchestrator picks). */
  preferredPeerId?: string
  /** Optional: pin to a specific runtime (otherwise any). */
  preferredRuntime?: AgentRuntime
}

/**
 * What the local agent receives when a Task completes.
 * Same shape as a remote AgentResult, but local.
 */
export interface TaskResult {
  taskId: TaskId
  status: 'completed' | 'failed' | 'partial' | 'disputed'
  content: ContentBlock[]
  verdict: Verdict
  costUsd: number
  durationMs: number
  workerPeerId: string
  workerRuntime: AgentRuntime
}
```

---

## 6. Permission system

### 6.1 The two axes, fully

The 3 × 4 = 12 states are:

| | `unless-trusted` | `on-request` | `granular` | `never` |
|---|---|---|---|---|
| `read-only` | Allow only known-safe read. Ask for everything else. | Model decides; only read commands run. | Per-tool config. | Run anything that fits read-only; no prompt. |
| `workspace-write` | Allow known-safe; ask for write+network. | Model decides; cwd-write OK; ask for non-cwd. | Per-tool config. | Run anything that fits workspace-write; no prompt. |
| `danger-full-access` | (effectively `never`, since the cap is gone) | Model decides; only real safety check is the user prompt. | Per-tool config. | Run anything; no prompt. **Owner-key signed.** |

The 12 cells are not "12 different products". They are 12 different *defaults* on the same permission + approval engine. The code is the same; the config differs.

### 6.2 The bash validators (real implementation)

```ts
// src/permissions/bash/read-only.ts
import type { BashValidator, BashValidationInput } from './index.js'
import type { BashVerdict } from './index.js'

/**
 * If the policy is read-only and the command writes, block.
 * Detection: any of `>`, `>>`, `tee`, `sed -i`, `mv`, `cp`, `rm`, `touch`, `mkdir`, `chmod`.
 *
 * This is not a parser. It's a heuristic. The composition of 6 such
 * heuristics is the security story, not any one of them.
 */
export const readOnlyValidation: BashValidator = {
  name: 'read-only',
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    if (input.policy.mode !== 'read-only') return { kind: 'allow' }
    const writePattern = />>?|tee |sed -i|\bmv\b|\bcp\b|\brm\b|\btouch\b|\bmkdir\b|\bchmod\b/i
    if (writePattern.test(input.command)) {
      return { kind: 'block', reason: 'read-only mode cannot write' }
    }
    return { kind: 'allow' }
  },
}
```

```ts
// src/permissions/bash/destructive-warning.ts
export const destructiveCommandWarning: BashValidator = {
  name: 'destructive-warning',
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    if (/rm\s+(-[a-z]*f[a-z]*\s+)?\/(\s|$)|dd\s+if=.*\s+of=\/dev/i.test(input.command)) {
      return { kind: 'allow-with-warning', warning: 'destructive: targets root or device' }
    }
    return { kind: 'allow' }
  },
}
```

```ts
// src/permissions/bash/mode.ts
export const modeValidation: BashValidator = {
  name: 'mode',
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    // Network access in non-network mode: block.
    if (!input.policy.networkAccess && /\bcurl\b|\bwget\b|\bnc\b|\bssh\b|\bnslookup\b/.test(input.command)) {
      return { kind: 'block', reason: 'network disabled in this mode' }
    }
    return { kind: 'allow' }
  },
}
```

```ts
// src/permissions/bash/sed.ts
export const sedValidation: BashValidator = {
  name: 'sed',
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    // sed -i on a system file is a common disaster.
    if (/sed\s+-i/.test(input.command)) {
      const systemPath = /\/etc\/|\/usr\/|\/var\/|\/bin\/|\/sbin\//.test(input.command)
      if (systemPath) {
        return { kind: 'block', reason: 'sed -i on system path blocked' }
      }
    }
    return { kind: 'allow' }
  },
}
```

```ts
// src/permissions/bash/path.ts
import * as path from 'node:path'

export const pathValidation: BashValidator = {
  name: 'path',
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    if (input.policy.mode !== 'workspace-write') return { kind: 'allow' }
    const roots = input.policy.writableRoots.length > 0
      ? input.policy.writableRoots
      : [input.cwd]
    for (const arg of input.argv) {
      if (arg.startsWith('/') || arg.startsWith('~')) {
        const resolved = path.resolve(input.cwd, arg)
        if (!roots.some(root => resolved.startsWith(root))) {
          return { kind: 'block', reason: `path ${arg} is outside writable_roots` }
        }
      }
    }
    return { kind: 'allow' }
  },
}
```

```ts
// src/permissions/bash/semantics.ts
export const commandSemanticsValidation: BashValidator = {
  name: 'command-semantics',
  async validate(input: BashValidationInput): Promise<BashVerdict> {
    // Detect common shell injection patterns: unbalanced quotes, backticks, etc.
    if (hasUnbalancedQuotes(input.command)) {
      return { kind: 'block', reason: 'unbalanced quotes' }
    }
    if (containsBackticks(input.command)) {
      return { kind: 'block', reason: 'backticks not allowed' }
    }
    return { kind: 'allow' }
  },
}
```

**Composition** (`src/permissions/bash/index.ts`):

```ts
export const ALL_VALIDATORS: ReadonlyArray<BashValidator> = [
  readOnlyValidation,
  modeValidation,
  sedValidation,
  pathValidation,
  destructiveCommandWarning,
  commandSemanticsValidation,
]

export async function validateBash(input: BashValidationInput): Promise<BashVerdict> {
  // First pass: any block short-circuits.
  for (const v of ALL_VALIDATORS) {
    const verdict = await v.validate(input)
    if (verdict.kind === 'block') return verdict
  }
  // Second pass: surface the worst warning, if any.
  for (const v of ALL_VALIDATORS) {
    const verdict = await v.validate(input)
    if (verdict.kind === 'allow-with-warning') return verdict
  }
  return { kind: 'allow' }
}
```

**Tests for these 6 validators are a parity lane** (`parity/01-bash-validation.toml`).

### 6.3 The PermissionEnforcer

```ts
// src/permissions/enforce.ts (sketch)
export type EnforcementResult =
  | { kind: 'allowed' }
  | { kind: 'denied', tool: string, mode: PermissionMode, reason: string }
  | { kind: 'ask', tool: string, reason: string }

export class PermissionEnforcer {
  constructor(
    private readonly policy: ResolvedPolicy,
    private readonly askUser: (q: AskUserQuestion) => Promise<AskUserAnswer>,
  ) {}

  async check(toolName: string, input: unknown): Promise<EnforcementResult> {
    const tool = this.toolRegistry.get(toolName)
    if (!tool) return { kind: 'denied', tool: toolName, mode: this.policy.mode, reason: 'unknown tool' }

    // 1. Permission mode: is this tool allowed at all in this mode?
    if (this.policy.mode === 'read-only' && tool.requires !== 'read-only') {
      return { kind: 'denied', tool: toolName, mode: 'read-only', reason: `requires ${tool.requires}` }
    }

    // 2. For bash, run the 6 validators.
    if (toolName === 'bash') {
      const verdict = await validateBash({ command: input.command, argv: input.argv, env: input.env, policy: this.policy, cwd: this.cwd })
      if (verdict.kind === 'block') return { kind: 'denied', tool: toolName, mode: this.policy.mode, reason: verdict.reason }
      if (verdict.kind === 'allow-with-warning') {
        // Surface warning via the UI; not a denial.
        await this.ui.notify(verdict.warning, 'warning')
      }
    }

    // 3. Approval: does the user need to be asked?
    if (this.policy.approval === 'never') return { kind: 'allowed' }
    if (this.policy.approval === 'unless-trusted' && tool.isSafe && tool.requires === 'read-only') {
      return { kind: 'allowed' }
    }
    if (this.policy.approval === 'on-request' && tool.requires === 'read-only' && tool.isSafe) {
      return { kind: 'allowed' }
    }
    return { kind: 'ask', tool: toolName, reason: this.reasonFor(tool, input) }
  }

  private async handleAsk(tool: string, input: unknown, reason: string): Promise<EnforcementResult> {
    const answer = await this.askUser({ prompt: `Allow ${tool}?`, reason, options: ['allow', 'deny', 'allow-always-this-session'] })
    if (answer.kind === 'allow-always-this-session') {
      this.sessionAllowed.add(tool)
      return { kind: 'allowed' }
    }
    return answer
  }
}
```

**Key invariant**: when a tool is denied or blocked, the model gets a `tool_result` with `isError: true` explaining why. The model can react — e.g., switch to a safer command, or stop. **Errors are visible.**

---

## 7. Sandbox system

### 7.1 The 3 backends

| Backend | Platform | Mechanism | Default? |
|---|---|---|---|
| `linux-landlock` | Linux | Kernel-level filesystem + network syscall filter | Yes on Linux |
| `process-fs-namespace` | macOS, Linux (fallback) | Mount namespace + chroot | Yes on macOS, fallback on Linux |
| `none` | All | No sandbox; rely on permissions | Only with `PermissionMode=danger-full-access` |

### 7.2 The resolution algorithm

```
1. Read config: permission_mode, sandbox_backend
2. If sandbox_backend == "auto":
   - if Linux → linux-landlock
   - if macOS → process-fs-namespace
   - if Windows → none (warn loudly)
3. If permission_mode == "danger-full-access":
   - sandbox_backend must be "none"
4. Initialize backend.
5. Apply policy: writable_roots, network_access, exclude_slash_tmp.
6. Probe: ensure the backend can actually enforce (e.g., landlock available, namespace can be created).
   - If probe fails: degrade to a safer backend; if no safer backend, refuse to start.
```

### 7.3 Landlock backend (sketch)

```ts
// src/sandbox/backend-linux-landlock.ts
export class LandlockBackend implements SandboxBackend {
  async applyPolicy(policy: SandboxPolicy, cwd: string): Promise<void> {
    // Build the ruleset from the policy.
    const ruleset: LandlockRuleset = await createRuleset()
    if (policy.mode === 'read-only') {
      // Allow read on all paths.
      ruleset.addRule(landlock.AccessFS.readFile, '/')
      ruleset.addRule(landlock.AccessFS.readDir, '/')
    } else if (policy.mode === 'workspace-write') {
      // Allow read everywhere.
      ruleset.addRule(landlock.AccessFS.readFile, '/')
      ruleset.addRule(landlock.AccessFS.readDir, '/')
      // Allow write only on writable_roots and /tmp (if exclude_slash_tmp).
      for (const root of policy.writableRoots.length > 0 ? policy.writableRoots : [cwd]) {
        ruleset.addRule(landlock.AccessFS.writeFile, root)
        ruleset.addRule(landlock.AccessFS.removeFile, root)
        ruleset.addRule(landlock.AccessFS.makeReg, root)
        ruleset.addRule(landlock.AccessFS.makeDir, root)
      }
      if (policy.excludeSlashTmp) {
        ruleset.addRule(landlock.AccessFS.writeFile, '/tmp')
        ruleset.addRule(landlock.AccessFS.removeFile, '/tmp')
        ruleset.addRule(landlock.AccessFS.makeReg, '/tmp')
        ruleset.addRule(landlock.AccessFS.makeDir, '/tmp')
      }
    } else {
      // danger-full-access: no ruleset restriction.
      return
    }
    // Apply via prctl(PR_SET_NO_NEW_PRIVS) + seccomp + landlock.
    await prctlSetNoNewPrivs()
    await seccompSetNoNewPrivs()
    await ruleset.apply()
  }
}
```

The other backends follow the same shape: build a ruleset from `SandboxPolicy`, apply.

---

## 8. Hook system

The hook system is the **extension surface** for users. They add a `[[hook.PreToolUse]]` to their `hooks.toml`, and a shell command or TS module runs at the right time.

### 8.1 The 12 events (full)

| Event | When | What handlers can do |
|---|---|---|
| `SessionStart` | Session is loaded, before first turn | `add-context` to inject instructions into the system prompt |
| `UserPromptSubmit` | User submits a message | `block` (don't process), `add-context` |
| `PreToolUse` | Before a tool call | `block` (don't run tool), `modify` (change input) |
| `PostToolUse` | After a tool call | `modify` (change result before it goes to the model) |
| `PreCompact` | Before context compaction | `add-context` (inject things that must survive) |
| `PostCompact` | After context compaction | (mostly for logging) |
| `Stop` | Main agent stops | (user may intervene; resume with new prompt) |
| `SubagentStop` | A sub-agent stops | (logging) |
| `Notification` | Permission prompt, idle timeout, etc. | (UI; handlers typically just log) |
| `PermissionRequest` | A permission decision is needed | `block` (deny upfront), `modify` (provide answer) |
| `Setup` | Once at install | (one-time setup: create directories, register MCP, etc.) |

### 8.2 The registry (real)

```ts
// src/hooks/registry.ts
export class HookRegistry {
  private handlers = new Map<HookEventName, HookHandler[]>()
  private middlewares: Array<(eventName: HookEventName, payload: unknown) => Promise<HookDecision>> = []

  /** Register a handler. */
  on(eventName: HookEventName, handler: HookHandler): void {
    const existing = this.handlers.get(eventName) ?? []
    existing.push(handler)
    this.handlers.set(eventName, existing)
  }

  /** Add a middleware (runs before handlers; can short-circuit). */
  use(middleware: (eventName: HookEventName, payload: unknown) => Promise<HookDecision>): void {
    this.middlewares.push(middleware)
  }

  /**
   * Fire an event. Returns the composed decision.
   *   - First `block` wins.
   *   - Otherwise, last `modify` wins (PostToolUse only).
   *   - Otherwise, all `add-context` are concatenated.
   *   - Otherwise, `continue`.
   */
  async fire(eventName: HookEventName, payload: unknown): Promise<HookDecision> {
    // Middlewares first. They can short-circuit.
    for (const middleware of this.middlewares) {
      const decision = await middleware(eventName, payload)
      if (decision.kind === 'block') return decision
    }

    const handlers = this.handlers.get(eventName) ?? []
    const matched = handlers.filter(h => this.matchHandler(h, payload))

    let lastModify: HookDecision | null = null
    const contexts: string[] = []

    for (const handler of matched) {
      const decision = await this.runHandler(handler, eventName, payload)
      if (decision.kind === 'block') return decision
      if (decision.kind === 'modify' && eventName === 'PostToolUse') {
        lastModify = decision
      }
      if (decision.kind === 'add-context') {
        contexts.push(decision.content)
      }
    }
    if (contexts.length > 0) {
      return { kind: 'add-context', content: contexts.join('\n\n') }
    }
    if (lastModify) return lastModify
    return { kind: 'continue' }
  }

  private matchHandler(handler: HookHandler, payload: unknown): boolean {
    if (!handler.match) return true
    if (handler.match.tool && (payload as { tool?: string }).tool !== handler.match.tool) {
      return false
    }
    if (handler.match.pattern) {
      const re = new RegExp(handler.match.pattern)
      if (!re.test(JSON.stringify(payload))) return false
    }
    return true
  }

  private async runHandler(handler: HookHandler, eventName: HookEventName, payload: unknown): Promise<HookDecision> {
    if (handler.command) {
      return await runShellHandler(handler.command, eventName, payload, handler.timeoutMs ?? 5000)
    }
    if (handler.module) {
      const mod = await import(handler.module)
      return await mod.default({ eventName, payload })
    }
    return { kind: 'continue' }
  }
}
```

### 8.3 The shell handler (real)

```ts
// src/hooks/runner.ts
import { spawn } from 'node:child_process'

export async function runShellHandler(
  command: string,
  eventName: HookEventName,
  payload: unknown,
  timeoutMs: number,
): Promise<HookDecision> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      env: {
        ...process.env,
        HOOK_EVENT: eventName,
        HOOK_PAYLOAD: JSON.stringify(payload),
        TOOL_CALL: JSON.stringify(payload),  // legacy alias
        RESULT_FILE: '',  // populated by PostToolUse
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout!.on('data', d => stdout += d.toString())
    child.stderr!.on('data', d => stderr += d.toString())
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) {
        resolve({ kind: 'block', reason: `hook timed out after ${timeoutMs}ms` })
        return
      }
      if (code !== 0) {
        // Non-zero exit: treat as block, surface stderr.
        resolve({ kind: 'block', reason: `hook exited ${code}: ${stderr.slice(0, 200)}` })
        return
      }
      // Parse stdout. JSON shape: { decision, content, modified, reason }
      try {
        const parsed = JSON.parse(stdout)
        if (parsed.decision === 'block') {
          resolve({ kind: 'block', reason: parsed.reason ?? 'blocked by hook' })
        } else if (parsed.decision === 'add-context') {
          resolve({ kind: 'add-context', content: parsed.content })
        } else {
          resolve({ kind: 'continue' })
        }
      } catch {
        // Non-JSON stdout: treat stdout as add-context.
        if (stdout.trim().length > 0) {
          resolve({ kind: 'add-context', content: stdout })
        } else {
          resolve({ kind: 'continue' })
        }
      }
    })
  })
}
```

**Hook handlers are sandboxed by the bash tool's permission system.** A hook that runs `rm -rf /` will be caught by `readOnlyValidation` if the session is in read-only mode. Hooks are not a back door; they are part of the same trust model.

### 8.4 Hook loader

```ts
// src/hooks/loader.ts
export async function loadHooksFromToml(path: string): Promise<HookRegistry> {
  const text = await fs.readFile(path, 'utf8')
  const parsed = Toml.parse(text) as Record<string, unknown>
  const registry = new HookRegistry()
  for (const [eventName, handlers] of Object.entries(parsed)) {
    if (!isHookEventName(eventName)) continue
    if (!Array.isArray(handlers)) continue
    for (const h of handlers) {
      if (typeof h === 'object' && h !== null) {
        registry.on(eventName, h as HookHandler)
      }
    }
  }
  return registry
}
```

---

## 9. AGENTS.md discovery (verbatim Codex pattern)

`src/agents-md/discover.ts`:

```ts
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

const AGENTS_MD_FILENAME = 'AGENTS.md'
const AGENTS_OVERRIDE_FILENAME = 'AGENTS.override.md'
const SEPARATOR = '\n\n--- project-doc ---\n\n'

export interface DiscoveredDoc {
  path: string
  contents: string
  origin: 'user' | 'project' | 'override'
  byteLength: number
}

export interface DiscoveryOptions {
  cwd: string
  projectRootMarkers: ReadonlyArray<string>  // default ['.git']
  fallbackFilenames: ReadonlyArray<string>   // default []
  maxBytes: number                            // default 32 KB
}

export interface DiscoveryResult {
  entries: ReadonlyArray<DiscoveredDoc>
  totalBytes: number
  assembled: string
}

/**
 * Walks up from cwd to the nearest ancestor with a project_root_marker,
 * collecting every AGENTS.md (and fallback filenames) along the way.
 *
 * Mirrors codex-rs/core/src/agents_md.rs:1-90, line for line.
 */
export async function discoverAgentsMd(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const { cwd, projectRootMarkers, fallbackFilenames, maxBytes } = opts

  // 1. Find project root by walking upward.
  const projectRoot = await findProjectRoot(cwd, projectRootMarkers)

  // 2. Collect every AGENTS.md from projectRoot to cwd (inclusive).
  const paths = await collectDocPaths({
    fromDir: projectRoot,
    toDir: cwd,
    filenames: [AGENTS_MD_FILENAME, ...fallbackFilenames],
  })

  // 3. Read each, respecting maxBytes budget.
  const entries: DiscoveredDoc[] = []
  let totalBytes = 0
  for (const p of paths) {
    if (totalBytes >= maxBytes) break
    try {
      const contents = await fs.readFile(p, 'utf8')
      const remaining = maxBytes - totalBytes
      const trimmed = contents.length > remaining
        ? contents.slice(0, remaining)
        : contents
      entries.push({
        path: p,
        contents: trimmed,
        origin: 'project',
        byteLength: Buffer.byteLength(trimmed, 'utf8'),
      })
      totalBytes += Buffer.byteLength(trimmed, 'utf8')
    } catch (err) {
      // Missing file is fine; permission error logs and continues.
      console.warn(`failed to read ${p}: ${err.message}`)
    }
  }

  // 4. Read the override if present (last, so it wins on conflicts).
  const overridePath = path.join(cwd, AGENTS_OVERRIDE_FILENAME)
  try {
    const contents = await fs.readFile(overridePath, 'utf8')
    const remaining = maxBytes - totalBytes
    if (remaining > 0) {
      const trimmed = contents.length > remaining
        ? contents.slice(0, remaining)
        : contents
      entries.push({
        path: overridePath,
        contents: trimmed,
        origin: 'override',
        byteLength: Buffer.byteLength(trimmed, 'utf8'),
      })
      totalBytes += Buffer.byteLength(trimmed, 'utf8')
    }
  } catch { /* no override, fine */ }

  // 5. Assemble. Each doc is preceded by an HTML comment with origin and path,
  //    so the model knows where each piece came from.
  const assembled = entries
    .map(e => `<!-- origin: ${e.origin} path: ${e.path} -->\n${e.contents}`)
    .join(SEPARATOR)

  return { entries, totalBytes, assembled }
}

async function findProjectRoot(cwd: string, markers: ReadonlyArray<string>): Promise<string> {
  if (markers.length === 0) return cwd
  let dir = path.resolve(cwd)
  const visited = new Set<string>()
  while (!visited.has(dir)) {
    visited.add(dir)
    for (const marker of markers) {
      try {
        await fs.access(path.join(dir, marker))
        return dir  // found
      } catch { /* not here */ }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return cwd  // hit filesystem root
    dir = parent
  }
  return cwd
}

async function collectDocPaths(input: {
  fromDir: string
  toDir: string
  filenames: ReadonlyArray<string>
}): Promise<string[]> {
  const { fromDir, toDir, filenames } = input
  const out: string[] = []
  let dir = path.resolve(toDir)
  const stop = path.resolve(fromDir)
  while (true) {
    for (const filename of filenames) {
      const p = path.join(dir, filename)
      out.push(p)
    }
    if (dir === stop) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out.reverse()  // root to cwd order
}
```

**This is the canonical pattern.** Don't reinvent; copy from Codex. The tests in `codex-rs/core/src/agents_md_tests.rs` are the parity test for this.

---

## 10. Tools

Tools are typed; the agent loop never calls raw functions. Each tool has an input schema, an output schema, a required permission mode, and a cost.

### 10.1 Built-in tools (v0)

| Name | Purpose | Requires | Cost USD |
|---|---|---|---|
| `read` | Read file contents | `read-only` | 0 |
| `write` | Write a file (overwrite or create) | `workspace-write` | 0.001 |
| `edit` | Apply targeted edits (apply_patch) | `workspace-write` | 0.002 |
| `bash` | Run a shell command | `read-only` (default; validators may add restrictions) | variable |
| `git` | git operations: status, diff, commit, push, branch, PR | `workspace-write` | 0 |
| `task` | Spawn a sub-agent (mesh-native) | `read-only` | 0.005 (orchestration) |
| `mcp__*` | MCP tools (dynamically registered) | per-tool | per-tool |

### 10.2 The git tool (auto branch/commit/PR)

```ts
// src/tools/git.ts (sketch)
export const gitTool: ToolDefinition<GitInput, GitOutput> = {
  name: 'git',
  description: 'Git operations: status, diff, commit, branch, push, PR creation.',
  inputSchema: GitInputSchema,
  outputSchema: GitOutputSchema,
  requires: 'workspace-write',
  costUsd: 0,
  async execute(input, ctx) {
    switch (input.op) {
      case 'status': return runGit(['status', '--porcelain'], ctx.cwd)
      case 'diff': return runGit(['diff', input.ref ?? 'HEAD'], ctx.cwd)
      case 'commit': {
        // Auto-create a branch if on main.
        const currentBranch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], ctx.cwd)
        if (currentBranch === 'main' || currentBranch === 'master') {
          const newBranch = `envoy/${ctx.sessionId}-${Date.now()}`
          await runGit(['checkout', '-b', newBranch], ctx.cwd)
        }
        return runGit(['commit', '-m', input.message, '--author', `envoy-harness <envoy@${ctx.ownerId}>`], ctx.cwd)
      }
      case 'push': {
        return runGit(['push', '-u', 'origin', 'HEAD'], ctx.cwd)
      }
      case 'pr': {
        // Use gh CLI if available; otherwise fail with a clear message.
        return runGh(['pr', 'create', '--title', input.title, '--body', input.body ?? ''], ctx.cwd)
      }
    }
  },
}
```

**Auto-branch** is the killer feature: when the agent commits, it never accidentally lands on `main` (or whatever the user's protected branch is). The branch is named `envoy/<sessionId>-<timestamp>`, so the user can easily find and squash.

### 10.3 The task tool (mesh-native sub-agent)

```ts
// src/tools/task.ts (sketch)
export const taskTool: ToolDefinition<TaskInput, TaskResult> = {
  name: 'task',
  description: 'Spawn a sub-agent. The sub-agent may run on this node or any peer in the mesh.',
  inputSchema: TaskInputSchema,
  outputSchema: TaskResultSchema,
  requires: 'read-only',  // the sub-agent's own permission applies
  costUsd: 0.005,
  async execute(input, ctx) {
    // 1. Build a chain step.
    const subtask: ChainSubtask = {
      chainId: ctx.parentChainId ?? `oneoff-${ctx.sessionId}-${randomUUID()}`,
      subtaskId: randomUUID(),
      requiredSkill: input.capabilityTag,
      objective: input.objective,
      costCeilingUsd: input.costCeilingUsd,
      deadlineMinutes: Math.ceil(input.deadlineMs / 60_000),
    }
    // 2. Sign with owner key.
    const signed = signCanonicalPayload(subtask, ctx.ownerPrivateKey)
    // 3. Submit to the mesh orchestrator.
    const response = await ctx.mesh.submitSubtask(signed, {
      preferredPeerId: input.preferredPeerId,
      preferredRuntime: input.preferredRuntime,
      timeoutMs: input.deadlineMs,
    })
    // 4. The orchestrator returns a SignedAgentResult. Wrap in TaskResult.
    return {
      taskId: subtask.subtaskId,
      status: response.verdict.kind === 'pass' ? 'completed' : response.verdict.kind === 'fail' ? 'failed' : 'partial',
      content: response.content,
      verdict: response.verdict,
      costUsd: response.metrics.costUsd,
      durationMs: response.metrics.durationMs,
      workerPeerId: response.peerId,
      workerRuntime: response.runtime,
    }
  },
}
```

The sub-agent's permission is **its own node's** policy, not the requester's. A requester in `read-only` can spawn a sub-agent in `workspace-write`; the cost is paid by the requester (per chain-budget-ledger), but the actions are taken on the worker's node with the worker's policy.

---

## 11. The reference MAP adapter

> **Where this code lives**: this entire section describes `src/mesh/adapter.ts` inside `@envoymesh/envoy-harness-adapter` (Package 3), **not** inside `@envoymesh/envoy-harness` (Package 1). envoy-harness does **not** contain a `mesh/` directory. The adapter is a thin bridge that knows about both; envoy-harness stays mesh-agnostic. See §1.3 for the repository strategy.
>
> The `EnvoyHarnessAdapter` class shown here is the **reference** implementation of `AgentAdapter`. Other mesh platforms (e.g. a hypothetical "XMesh") can follow this same pattern for their own integration.

```ts
import type {
  AgentAdapter,
  CapabilityManifest,
  SignedAgentResult,
  Verdict,
  VerdictEntry,
  AgentRuntime,
  SkillDescriptor,
  ContentBlock,
  AgentResult,
} from '@envoymesh/protocol'
import { signCanonicalPayload } from '@envoymesh/identity'

export const ENVOY_HARNESS_VERSION = '0.0.0'

/**
 * The skill catalog envoy-harness advertises. Each skill maps to a
 * known tool composition in the local agent.
 */
export const ENVOY_HARNESS_SKILLS: ReadonlyArray<SkillDescriptor> = [
  { skillId: 'code-edit',  description: 'Read, edit, and write code in a project.', costCeilingUsd: 5.00, maxSensitivity: 'private', tags: ['code', 'edit'] },
  { skillId: 'code-review', description: 'Review a diff for correctness and style.',     costCeilingUsd: 3.00, maxSensitivity: 'private', tags: ['code', 'review'] },
  { skillId: 'doc-search',  description: 'Search docs and notes for a query.',          costCeilingUsd: 1.00, maxSensitivity: 'friends', tags: ['doc', 'search'] },
  { skillId: 'bash-run',    description: 'Run a constrained bash command on the worker.', costCeilingUsd: 0.50, maxSensitivity: 'friends', tags: ['bash', 'shell'] },
  { skillId: 'plan',        description: 'Read-only planning and exploration.',         costCeilingUsd: 1.00, maxSensitivity: 'friends', tags: ['plan'] },
]

export class EnvoyHarnessAdapter implements AgentAdapter {
  readonly runtime: AgentRuntime = 'envoy-harness'

  constructor(
    private readonly peerId: string,
    private readonly ownerId: string,
    private readonly ownerPrivateKey: CryptoKey,
    private readonly localRunner: LocalRunner,  // see §11.1
  ) {}

  describeSkills(): SkillDescriptor[] {
    return [...ENVOY_HARNESS_SKILLS]
  }

  /**
   * Build a signed manifest for broadcast. Owner signs.
   */
  async buildManifest(input: { reputationBySkill: Record<string, number> }): Promise<CapabilityManifest> {
    const unsigned: CapabilityManifest = {
      runtime: this.runtime,
      runtimeVersion: ENVOY_HARNESS_VERSION,
      peerId: this.peerId,
      ownerId: this.ownerId,
      skills: this.describeSkills(),
      reputationBySkill: input.reputationBySkill,
      issuedAt: new Date().toISOString(),
      ttlSeconds: 300,
    }
    return signCanonicalPayload(unsigned, this.ownerPrivateKey)
  }

  /**
   * Execute a skill on the local envoy-harness runtime. No HTTP, no CLI,
   * no translation. Direct call.
   */
  async execute(input: SkillExecutionInput): Promise<SignedAgentResult> {
    const result = await this.localRunner.run({
      skillId: input.skillId,
      objective: input.objective,
      inputArtifacts: input.inputArtifacts,
      costCeilingUsd: input.costCeilingUsd,
      deadlineMs: input.deadlineMs,
      signal: input.signal,
    })
    return signCanonicalPayload(result, this.ownerPrivateKey)
  }

  /**
   * envoy-harness's verifier is the most complete: 6 rule-based checks,
   * plus a verifier LLM (when configured), plus cross-agent agreement
   * (when the worker is on a different runtime). Other adapters ship
   * a subset and grow.
   */
  async verify(input: { result: SignedAgentResult; objective: string }): Promise<Verdict[]> {
    const verdicts: Verdict[] = []
    for (const rule of ALL_VERIFIER_RULES) {
      const v = await rule.check(input.result, input.objective)
      if (v !== null) verdicts.push(v)
    }
    return verdicts
  }
}
```

### 11.1 The LocalRunner

`LocalRunner` is the bridge from the MAP adapter to the local envoy-harness session. It opens a *new* session on the local node (so the sub-agent has its own AGENTS.md, hooks, and permission state), runs the skill, and returns the result.

```ts
// src/mesh/local-runner.ts (sketch)
export class LocalRunner {
  constructor(private readonly agent: Agent) {}

  async run(input: LocalRunnerInput): Promise<AgentResult> {
    // 1. Create a sub-session with its own permission state.
    //    Important: sub-sessions inherit parent's settings but get
    //    a fresh AGENTS.md and a fresh hook context.
    const subSession = await this.agent.createSession({
      mode: this.deriveModeFromCostCeiling(input.costCeilingUsd),
      approval: 'never',  // sub-agent runs unattended; mesh orchestrator already approved
      agentsMd: undefined,  // re-discover from cwd (the worker's cwd, not the requester's)
    })

    // 2. Build the system prompt.
    const systemPrompt = buildSystemPrompt({
      skillId: input.skillId,
      objective: input.objective,
      agentsMd: subSession.agentsMd,
    })

    // 3. Run the turn loop.
    let finalContent: ContentBlock[] = []
    let costUsd = 0
    let promptTokens = 0
    let completionTokens = 0
    const start = Date.now()
    for await (const event of subSession.run([userText(input.objective)], {
      signal: input.signal,
      systemPrompt,
    })) {
      if (event.kind === 'assistant_text_delta') {
        // Accumulate text for a final text block.
      } else if (event.kind === 'tool_result') {
        // Tools are allowed here. The sub-session has its own permission state.
      } else if (event.kind === 'assistant_message') {
        finalContent = [...finalContent, { kind: 'text', text: event.message.text, mimeType: 'text/markdown' }]
      } else if (event.kind === 'turn_end') {
        costUsd = subSession.costTracker.totalUsd
        promptTokens = subSession.costTracker.promptTokens
        completionTokens = subSession.costTracker.completionTokens
      }
    }
    const end = Date.now()

    // 4. Close the sub-session.
    await subSession.close()

    // 5. Build the AgentResult.
    return {
      skillId: input.skillId,
      runtime: 'envoy-harness',
      peerId: this.agent.peerId,
      correlationId: input.correlationId,
      content: finalContent,
      citations: [],
      metrics: { durationMs: end - start, promptTokens, completionTokens, costUsd },
      completedAt: new Date().toISOString(),
    }
  }
}
```

**Why a sub-session, not a sub-task in the same session?** Because each skill should have its own AGENTS.md (the worker's cwd is different from the requester's), its own permission state (the requester may be in read-only but the worker may need write), and its own hook context. **Sessions are the unit of isolation.**

---

## 12. Verifier

The verifier checks whether a result actually answers the objective. The local rule engine is fast and free; the LLM verifier is the escalation path.

### 12.1 The 6 rule-based checks

```ts
// src/verifier/rules/output-matches-objective.ts
export const outputMatchesObjective: VerifierRule = {
  name: 'output-matches-objective',
  async check(result: AgentResult, objective: string): Promise<Verdict | null> {
    const text = concatText(result.content)
    if (text.length === 0) {
      return { kind: 'fail', reason: 'empty output' }
    }
    // A cheap heuristic: does the text contain at least one keyword from the objective?
    const keywords = extractKeywords(objective)
    const matched = keywords.filter(kw => text.toLowerCase().includes(kw.toLowerCase()))
    if (matched.length < keywords.length * 0.5) {
      return { kind: 'partial', reason: `output matches ${matched.length}/${keywords.length} keywords` }
    }
    return { kind: 'pass', score: matched.length / keywords.length, confidence: 'low' }
  },
}
```

The other 5 rules follow the same shape:

- `non-empty-content` — at least one text/structured block.
- `sandbox-respected` — no content includes paths outside the worker's policy.
- `approval-respected` — no content suggests the worker did something the mandate forbade.
- `mesh-task-shape` — `result.content` is a valid `ContentBlock[]` per the schema.
- `cost-reasonable-for-work` — `metrics.costUsd` is within a reasonable range for the skill.

**The rule set is shipped as a single JSON file** at `$ENVOY_HOME/agent-state/<peer>/verifier-rules.json`. The 5-step protocol edits this file (see §13).

### 12.2 The composite verifier

```ts
// src/verifier/composite.ts
export async function runVerifierRules(
  result: AgentResult,
  objective: string,
  ruleSet: ReadonlyArray<VerifierRule>,
): Promise<Verdict[]> {
  const verdicts: Verdict[] = []
  for (const rule of ruleSet) {
    const v = await rule.check(result, objective)
    if (v !== null) verdicts.push(v)
  }
  return verdicts
}

export function combineVerdicts(verdicts: Verdict[]): Verdict {
  if (verdicts.some(v => v.kind === 'fail')) {
    return verdicts.find(v => v.kind === 'fail')!
  }
  if (verdicts.length === 0) {
    return { kind: 'disputed', needsHuman: true, signals: ['verifier produced no verdicts'] }
  }
  if (verdicts.every(v => v.kind === 'pass')) {
    const scores = verdicts.filter(v => v.kind === 'pass').map(v => v.score)
    return {
      kind: 'pass',
      score: scores.reduce((a, b) => a + b, 0) / scores.length,
      confidence: scores.length >= 3 ? 'high' : 'medium',
    }
  }
  // Some pass, some partial: degrade to partial.
  return { kind: 'partial', score: 0.5, reason: 'verifier disagreement' }
}
```

### 12.3 The LLM source (escalation)

```ts
// src/verifier/source-llm.ts
export async function llmSource(input: {
  result: AgentResult
  objective: string
  model: Model
  prompt: string  // configurable
}): Promise<Verdict> {
  const userPrompt = `You are verifying a worker agent's output.

OBJECTIVE (what the user asked for):
${input.objective}

WORKER OUTPUT:
${serializeAgentResult(input.result)}

Decide:
- pass: the output addresses the objective
- partial: the output partially addresses the objective
- fail: the output does not address the objective

Respond with a JSON object: { kind, score, reason }.
`
  const response = await callModel(input.model, [
    { role: 'system', content: input.prompt },
    { role: 'user', content: userPrompt },
  ])
  return parseVerdictFromLlm(response)
}
```

The LLM verifier uses a **cheaper model than the worker** (e.g. worker uses `claude-opus-4`, verifier uses `claude-haiku`). The intuition: the worker is the expensive one; the verifier checks the worker's claim, so it should be cheaper.

### 12.4 The 4-source cascade

```
1. ALWAYS run all 6 rules. Combine.
2. If combined verdict is 'pass': done. Record VerdictEntry.
3. If 'fail': done. Record. (orchestrator may roll back cost reserve.)
4. If 'partial' or 'disputed': run LLM source. Combine with rule verdicts.
5. If still 'partial' or 'disputed': escalate to human (Notification hook fires).
6. If chain has criticality='high': also run cross-source (compare with a parallel
   envoy-harness result on a different model).
```

**This is the verifier silver bullet from `harness-design/design.md` §10, instantiated for envoy-harness.**

---

## 13. Self-evolution (5-step protocol)

`src/agents-md/self-evolve.ts` — the runtime for the Penguin-style 5-step protocol, applied to the user's AGENTS.md and the verifier ruleset.

### 13.1 The protocol, with code

```ts
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

const ScoreboardEntrySchema = z.object({
  version: z.number().int().positive(),
  hypothesis: z.string(),
  rulesetHash: z.string(),
  meanScore: z.number().min(0).max(1),
  passRateBefore: z.number().min(0).max(1),
  passRateAfter: z.number().min(0).max(1),
  nRuns: z.number().int().nonnegative(),
  status: z.enum(['kept', 'reverted']),
  ownerSignature: z.string(),
  createdAt: z.string().datetime(),
})
type ScoreboardEntry = z.infer<typeof ScoreboardEntrySchema>

export class SelfEvolve {
  constructor(
    private readonly paths: {
      scoreboard: string   // ~/.envoymesh/agent-state/<peer>/verifier-scoreboard.yaml
      snapshotDir: string   // ~/.envoymesh/agent-state/<peer>/snapshots/
      benchmark: string    // ~/.envoymesh/agent-state/<peer>/benchmarks/<name>/frozen.yaml
      ruleset: string      // ~/.envoymesh/agent-state/<peer>/verifier-rules.json
      agentsMd: string      // ~/.envoymesh/agent-state/<peer>/AGENTS.md
    },
    private readonly ownerKey: CryptoKey,
    private readonly model: Model,
  ) {}

  /**
   * Run one cycle of the 5-step protocol.
   */
  async runOneCycle(): Promise<{ kept: boolean; entry: ScoreboardEntry }> {
    // 1. SNAPSHOT — copy current state.
    const version = (await this.latestVersion()) + 1
    const snapshot = path.join(this.paths.snapshotDir, `v${version}.tar.gz`)
    await this.snapshot(snapshot)

    // 2. HYPOTHESIZE — model proposes a specific change.
    const hypothesis = await this.proposeHypothesis()
    if (!hypothesis) {
      // No actionable hypothesis; record and exit.
      return { kept: false, entry: await this.recordEntry(version, { hypothesis: 'no actionable hypothesis', status: 'reverted', /* ... */ }) }
    }

    // 3. CANDIDATE — apply the change to a candidate.
    const candidate = await this.applyCandidate(hypothesis)
    const candidatePath = path.join(this.paths.snapshotDir, `v${version}.candidate.json`)
    await fs.writeFile(candidatePath, JSON.stringify(candidate, null, 2))

    // 4. EVALUATE — run the benchmark on the candidate.
    const before = await this.scoreboardBaseline()
    const after = await this.runBenchmark(candidate, this.paths.benchmark)

    // 5. COMMIT/REVERT — strict greater pass rate keeps it.
    const kept = after.passRate > before.passRate
    const entry: ScoreboardEntry = {
      version,
      hypothesis: hypothesis.text,
      rulesetHash: hash(candidate),
      meanScore: after.meanScore,
      passRateBefore: before.passRate,
      passRateAfter: after.passRate,
      nRuns: after.nRuns,
      status: kept ? 'kept' : 'reverted',
      ownerSignature: await signCanonicalPayload({ version, hypothesis: hypothesis.text, after }, this.ownerKey),
      createdAt: new Date().toISOString(),
    }
    await this.recordEntry(version, entry)
    if (kept) {
      await this.commitCandidate(candidate)
    } else {
      // Already snapshotted; nothing to undo.
    }
    return { kept, entry }
  }

  private async proposeHypothesis(): Promise<{ text: string; ruleChanges: VerifierRule[]; agentsMdChanges?: string } | null> {
    // Build a prompt from the scoreboard's recent failures.
    const recent = await this.recentFailures(20)
    const prompt = `You are the self-evolution optimizer for envoy-harness.

The recent 20 task failures (from scoreboard) are:
${JSON.stringify(recent, null, 2)}

Propose ONE specific, falsifiable change to the verifier ruleset that would
catch more of these failures. Be conservative: small, targeted changes only.

Output JSON: { hypothesis: string, ruleChanges: VerifierRule[] }
`
    const response = await callModel(this.model, [{ role: 'user', content: prompt }])
    return parseHypothesisFromLlm(response)
  }

  private async runBenchmark(candidate: VerifierRuleset, benchmarkPath: string): Promise<BenchmarkResult> {
    // Load the frozen benchmark. For each case, run with the candidate.
    const benchmark = await loadBenchmark(benchmarkPath)
    const results: Array<{ pass: boolean }> = []
    for (const task of benchmark.tasks) {
      const result = await this.runOneWithRuleset(task, candidate)
      results.push({ pass: result.verdict.kind === 'pass' })
    }
    const passRate = results.filter(r => r.pass).length / results.length
    return { passRate, meanScore: passRate, nRuns: results.length, tasks: results }
  }

  private async recordEntry(version: number, partial: Partial<ScoreboardEntry>): Promise<ScoreboardEntry> {
    const entry: ScoreboardEntry = {
      version,
      hypothesis: partial.hypothesis ?? 'unknown',
      rulesetHash: partial.rulesetHash ?? 'unknown',
      meanScore: partial.meanScore ?? 0,
      passRateBefore: partial.passRateBefore ?? 0,
      passRateAfter: partial.passRateAfter ?? 0,
      nRuns: partial.nRuns ?? 0,
      status: partial.status ?? 'reverted',
      ownerSignature: await signCanonicalPayload(partial, this.ownerKey),
      createdAt: new Date().toISOString(),
    }
    // Append to scoreboard.yaml (atomic write).
    const existing = await this.readScoreboard()
    existing.push(entry)
    await fs.writeFile(this.paths.scoreboard, serializeYaml(existing))
    return entry
  }
}
```

### 13.2 The contamination guard

The optimizer **never sees**:
- The rubric (the private evaluation criteria).
- The gold answers.

The optimizer **does see**:
- The scoreboard's recent failures (descriptions only, not gold).
- The current ruleset.
- The candidate ruleset it is proposing.

This is the same guard Penguin uses (`agent-optimization/SKILL.md` explicit "do not inspect Rubrics, Gold answers, private scoring conditions"). **In envoy-harness, the guard is enforced by the API**: the optimizer's prompt assembly function (`proposeHypothesis`) does not include the rubric or gold files; only the scoreboard entries and the current ruleset.

### 13.3 The federated scoreboard

A peer running envoy-harness can opt in to a **federated scoreboard**: pulling rules that have been validated by other peers running envoy-harness, on similar tasks.

```ts
// src/scoreboard/mesh.ts (sketch)
export class FederatedScoreboard {
  async pull(optIn: boolean): Promise<void> {
    if (!optIn) return
    // 1. Query bonded peers for their public scoreboard.
    const peerScoreboards = await this.broadcastAndCollect({ kind: 'federated_pull_request' })
    // 2. For each candidate rule, run it through the local 5-step protocol.
    for (const entry of peerScoreboards.flatMap(p => p.entries)) {
      if (entry.status !== 'kept') continue
      const local = await this.localSelfEvolve.runOneCycleAgainst({
        hypothesis: entry.hypothesis,
        ruleChanges: entry.ruleChanges,
      })
      if (local.kept) {
        // Adopted.
        await this.recordFederatedAdoption(entry)
      }
    }
  }
}
```

**Pull is opt-in, never push.** A peer never receives rules automatically; the operator must opt in, and the local 5-step protocol is the final gate.

---

## 14. Cost tracking

Cost is tracked **per turn, not per session end**.

```ts
// src/cost/tracker.ts
export class CostTracker {
  private promptTokens = 0
  private completionTokens = 0
  private costByProvider = new Map<string, number>()
  private readonly costCeilingUsd: number
  private readonly warnAtUsd: number

  constructor(opts: { costCeilingUsd: number; warnAtUsd: number }) {
    this.costCeilingUsd = opts.costCeilingUsd
    this.warnAtUsd = opts.warnAtUsd
  }

  /**
   * Record a model call. Returns whether the call is allowed.
   */
  recordModelCall(call: { promptTokens: number; completionTokens: number; costUsd: number; provider: string }): { allowed: boolean; reason?: string } {
    this.promptTokens += call.promptTokens
    this.completionTokens += call.completionTokens
    this.costByProvider.set(call.provider, (this.costByProvider.get(call.provider) ?? 0) + call.costUsd)
    if (this.totalUsd >= this.costCeilingUsd) {
      return { allowed: false, reason: `cost ceiling ${this.costCeilingUsd} exceeded` }
    }
    if (this.totalUsd >= this.warnAtUsd) {
      // Surface to UI but don't stop.
    }
    return { allowed: true }
  }

  get totalUsd(): number {
    let sum = 0
    for (const v of this.costByProvider.values()) sum += v
    return sum
  }

  report(): CostReport {
    return {
      totalUsd: this.totalUsd,
      byProvider: Object.fromEntries(this.costByProvider),
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
    }
  }
}
```

**The user sees cost growing.** After each turn, the UI shows "spent $0.42 of $5.00 cap". If a model call would push over the cap, the call is refused, the model gets a `tool_result` with `isError: true` ("cost ceiling exceeded"), and the user is asked to extend the cap or end the session.

### 14.1 Pre-execution cost estimation

For long-running tasks, the user wants a cost estimate **before** the agent starts. The estimator looks at the task's complexity (objective length, AGENTS.md size, history of similar tasks) and gives a range:

```ts
// src/cost/estimator.ts (sketch)
export async function estimateCost(input: {
  objective: string
  agentsMdSize: number
  historyMean: number  // mean cost of similar past tasks
}): Promise<{ min: number; max: number; mean: number }> {
  const base = input.historyMean * 1.2  // 20% buffer
  const sizeAdjustment = Math.log2(input.agentsMdSize / 4096 + 1) * 0.05
  return { min: base * 0.5, max: base * 2.0, mean: base + sizeAdjustment }
}
```

This is a heuristic, not a guarantee. The actual cost may exceed the max. The estimator is for setting expectations, not for hard limits (those are the cap).

---

## 15. Sub-agent protocol (the mesh-native flow)

When `envoy task` is called, the following happens end to end:

```
ALICE'S NODE (envoy-harness)
─────────────────────────────────────────────────
1. CLI parses "envoy task ..."
2. Task tool's execute() is called.
3. Build ChainSubtask, sign with owner key.
4. mesh/chain-submit.ts broadcasts task.propose to bonded peers.

           ┌──── broadcast: task.propose ────┐
           │                                    │
           ▼                                    ▼
   BOB'S NODE                          CAROL'S NODE
   (OpenClaw)                          (Pi)
   ────────────                        ─────
5a. Receives the proposal.              5b. Receives the proposal.
6a. Bob's orchestrator evaluates        6b. Carol's orchestrator
    Alice's reputation +                 evaluates Alice's
    capability match.                     reputation + capability.
7a. Bob bids:                           7b. Carol bids:
    "I can do code-search,                "I can do code-search,
     my bid is $0.30"                     my bid is $0.45"
8. Alice's orchestrator picks Bob       (Carol lost the bid)
    (cheaper + same reputation).

9. Bob's worker executes the subtask via OpenClawAdapter.
10. OpenClawAdapter's verifier runs (rule-based only — Bob's OpenClaw
    doesn't have the LLM verifier yet).
11. Bob produces a SignedAgentResult, signed with Bob's owner key.
12. Bob's orchestrator returns the result to Alice.

ALICE'S NODE (envoy-harness, continues)
─────────────────────────────────────────────────
13. Task tool's execute() receives the result.
14. The MAP adapter's verify() runs:
    - 6 rule-based checks (envoy-harness is the most complete)
    - Optionally, if the task is criticality='high', cross-agent verification
      (Alice's envoy-harness also runs the same task and compares)
15. Verdict is recorded as a VerdictEntry in the ArbitrationStore.
16. The cost is recorded in chain-budget-ledger.ts.
17. The TaskResult is returned to the agent loop.
18. The model sees the sub-agent's result in a tool_result.
19. The turn continues (the model may run more tool calls based on the result).
```

**Key observations**:

- The requester pays the cost (Alice's node).
- The worker does the work (Bob's node).
- The verification is the requester's responsibility (Alice's envoy-harness has the most complete verifier).
- The cross-agent comparison is opt-in (only on critical tasks).

---

## 16. Observability

Every turn produces a stream of `SessionEvent`s. The user can see them in the TUI, in the JSON Lines output (`--json`), or in the web UI (future).

### 16.1 Event types

```ts
export type SessionEvent = DiscriminatedUnion<{
  'session_start': { config: ResolvedConfig, agentsMdBytes: number }
  'session_end': { durationMs: number, costReport: CostReport, totalTurns: number }
  'turn_start': { turnIndex: number }
  'user_message': { text: string }
  'assistant_text_delta': { delta: string }
  'assistant_message': { content: string, toolCalls: ToolCall[] }
  'tool_call': { name: string, input: unknown }
  'tool_result': { name: string, result: unknown, isError: boolean, durationMs: number }
  'tool_blocked': { name: string, reason: string, by: 'hook' | 'permission' }
  'tool_denied': { name: string, reason: string, by: 'user' }
  'hook_fired': { event: HookEventName, handlerCount: number, decision: HookDecision }
  'permission_asked': { name: string, reason: string, answer: 'allow' | 'deny' | 'allow-session' }
  'cost_update': { spentUsd: number, ceilingUsd: number, warning?: string }
  'verifier_fired': { source: VerifierSource, verdict: Verdict, durationMs: number }
  'turn_end': { turnIndex: number, costUsd: number }
  'stop': { reason: 'completed' | 'user_stop' | 'cost_ceiling' | 'error' }
}>
```

### 16.2 JSON Lines output

```
$ envoy "summarize src/foo.ts" --json | tee session.jsonl
{"kind":"session_start","config":{...},"agentsMdBytes":1024}
{"kind":"user_message","text":"summarize src/foo.ts"}
{"kind":"turn_start","turnIndex":0}
{"kind":"assistant_text_delta","delta":"I'll read the file first."}
{"kind":"tool_call","name":"read","input":{"path":"src/foo.ts"}}
{"kind":"hook_fired","event":"PreToolUse","handlerCount":2,"decision":{"kind":"continue"}}
{"kind":"tool_result","name":"read","result":{...},"isError":false,"durationMs":12}
{"kind":"assistant_text_delta","delta":"\n\nSummary: ..."}
{"kind":"turn_end","turnIndex":0,"costUsd":0.012}
{"kind":"stop","reason":"completed"}
{"kind":"session_end","durationMs":8432,"costReport":{...},"totalTurns":1}
```

This format is consumable by `jq`, by trace UIs, by replay tools.

### 16.3 The session log (durable)

`$ENVOY_HOME/sessions/<sessionId>.jsonl` — append-only, one event per line. The session can be resumed after a crash by reading the log. This is the "model-visible means logged" invariant: anything the model sees is reconstructable from the log.

---

## 17. Error handling

### 17.1 TaggedError

Borrowed from Pi (`pi/packages/agent/src/harness/agent-harness.ts:28-55`):

```ts
// src/errors/tagged-error.ts
export class TaggedError<T extends string, D extends object> extends Error {
  readonly _tag: T
  readonly data: D
  constructor(tag: T, data: D) {
    super(data.message as string ?? tag)
    this._tag = tag
    this.data = data
    this.name = tag
  }
}

export function tagged<T extends string, D extends object>(tag: T) {
  return class extends TaggedError<T, D> {
    constructor(data: D) { super(tag, data) }
  }
}
```

Usage:

```ts
export class LaneBusy extends tagged('LaneBusy')<{
  lane: string
  operationId: string
  message: string
}>() {}

export class BashBlocked extends tagged('BashBlocked')<{
  command: string
  validator: string
  reason: string
  message: string
}>() {}
```

### 17.2 The error propagation rules

1. **Tools never throw across the dispatch boundary.** They return `{ kind: 'error', ... }`. The agent loop converts to a `tool_result` with `isError: true`.
2. **Hooks may throw (timeout, exit nonzero).** The hook runner catches and converts to `{ kind: 'block', reason: ... }`.
3. **Verifiers may throw.** The composite catches and treats as `disputed`.
4. **Sandbox init may throw.** Caught and surfaced to the user with a clear "could not start sandbox; falling back to mode X" or "aborting session".
5. **Model calls may throw.** Treated as `turn_end` with `stop: { reason: 'error' }`; the user can retry.

**The principle: every error path is typed and visible.** A `BashBlocked` error tells the user *which validator blocked which command*; not a string "command failed".

---

## 18. File and module layout

The layout below shows **Package 1: `@envoymesh/envoy-harness`**. Package 2 (`@envoymesh/protocol`) and Package 3 (`@envoymesh/envoy-harness-adapter`) are listed separately at the end of this section. See §1.3 for the repository strategy.

```
packages/envoy-harness/                    # @envoymesh/envoy-harness on npm
├── package.json                              # name: "@envoymesh/envoy-harness"
│                                            # deps: none from EnvoyMesh monorepo (per §1.3.1)
├── tsconfig.json
├── README.md                                 # "envoy-harness is the reference CLI agent"
├── src/
│   ├── index.ts                              # public API exports
│   ├── types.ts                              # schemas and types in §5
│   ├── agent.ts                              # Agent class (lifecycle, long-lived)
│   ├── session.ts                            # Session (state machine, agent loop)
│   ├── cli.ts                                # CLI entry, flag parsing
│   ├── slash-cmds.ts                         # /help, /compact, /reload, /status
│   ├── output/
│   │   ├── stream-json.ts                    # JSON Lines streaming
│   │   ├── human.ts                          # pretty terminal
│   │   └── compact.ts                        # context compaction
│   ├── permissions/
│   │   ├── mode.ts                           # PermissionMode resolution
│   │   ├── approval.ts                       # AskForApproval + UI prompt
│   │   ├── profile.ts                        # profile loading from $ENVOY_HOME
│   │   ├── enforce.ts                        # PermissionEnforcer (the loop's check)
│   │   └── bash/
│   │       ├── index.ts                     # composition of all 6 validators
│   │       ├── read-only.ts
│   │       ├── destructive-warning.ts
│   │       ├── mode.ts
│   │       ├── sed.ts
│   │       ├── path.ts
│   │       └── semantics.ts
│   ├── sandbox/
│   │   ├── policy.ts                         # SandboxPolicy resolution
│   │   ├── backend-linux-landlock.ts
│   │   ├── backend-process-namespace.ts
│   │   └── backend-none.ts
│   ├── hooks/
│   │   ├── registry.ts                       # 12 hook event types
│   │   ├── loader.ts                         # load from $ENVOY_HOME/hooks.toml
│   │   ├── runner.ts                         # execute handlers (shell or module)
│   │   └── events/                           # per-event payload shape
│   │       ├── pre-tool-use.ts
│   │       ├── post-tool-use.ts
│   │       ├── pre-compact.ts
│   │       ├── post-compact.ts
│   │       ├── session-start.ts
│   │       ├── session-end.ts
│   │       ├── stop.ts
│   │       ├── subagent-stop.ts
│   │       ├── user-prompt-submit.ts
│   │       ├── notification.ts
│   │       ├── permission-request.ts
│   │       └── setup.ts
│   ├── agents-md/
│   │   ├── discover.ts                       # walk up from cwd, concat (verbatim Codex)
│   │   ├── assemble.ts                       # build LoadedAgentsMd
│   │   └── self-evolve.ts                    # 5-step protocol
│   ├── tools/
│   │   ├── registry.ts                       # tool dispatch
│   │   ├── read.ts
│   │   ├── write.ts
│   │   ├── edit.ts                           # apply_patch
│   │   ├── bash.ts                           # uses permissions/bash/*
│   │   ├── git.ts                            # auto branch/commit/PR
│   │   ├── mcp-client.ts
│   │   ├── mcp-server.ts                     # envoy-harness as MCP server
│   │   └── lsp-client.ts                     # optional, parity with claw-code lane 8
│   ├── mcp/
│   │   ├── client.ts                         # MCP client SDK
│   │   ├── server.ts                         # MCP server SDK
│   │   ├── transport.ts                      # stdio + http transports
│   │   └── lifecycle.ts                      # spawn, health, shutdown
│   ├── config/
│   │   ├── loader.ts                         # TOML loading + layer composition
│   │   ├── schema.ts                         # Zod schemas for config.toml
│   │   ├── profile.ts                        # profile resolution
│   │   └── profiles/
│   │       ├── read-only.toml
│   │       ├── workspace-write.toml
│   │       └── danger-full-access.toml
│   ├── verifier/
│   │   ├── rules/
│   │   │   ├── output-matches-objective.ts
│   │   │   ├── non-empty-content.ts
│   │   │   ├── sandbox-respected.ts
│   │   │   ├── approval-respected.ts
│   │   │   ├── task-shape.ts                 # output conforms to AgentResult schema
│   │   │   └── cost-reasonable-for-work.ts
│   │   ├── composite.ts                      # OR-of-pass, AND-of-fail
│   │   └── source-llm.ts                     # verifier LLM
│   ├── scoreboard/
│   │   ├── local.ts                          # per-node, per-runtime
│   │   └── ruleset-loader.ts                 # load verifier-rules.json
│   ├── cost/
│   │   ├── tracker.ts                        # per-session cost
│   │   ├── estimator.ts                      # pre-execution cost estimate
│   │   └── report.ts                         # post-execution report
│   └── errors/
│       └── tagged-error.ts                   # TaggedError + Result
├── bin/
│   └── envoy                                 # CLI entry point (shebang)
├── parity/
│   ├── 01-bash-validation.toml               # claw-code parity lane 1
│   ├── 02-sandbox.toml
│   ├── 03-file-tool.toml
│   ├── 04-task-registry.toml
│   ├── 05-task-wiring.toml
│   ├── 06-team-cron.toml                     # (optional parity)
│   ├── 07-mcp-lifecycle.toml
│   ├── 08-lsp-client.toml                    # (optional parity)
│   └── 09-permission-enforcement.toml
├── test/
│   ├── unit/                                 # per-module unit tests
│   ├── e2e/                                  # end-to-end session tests
│   └── parity/                               # executable parity tests from parity/*.toml
└── docs/
    ├── USAGE.md                              # how to use envoy
    ├── CONFIG.md                             # config.toml reference
    ├── HOOKS.md                              # 12 hook events with examples
    ├── MCP.md                                # MCP client + server
    └── SELF-EVOLUTION.md                     # 5-step protocol reference
```

**Three structural commitments**:

- Every `permissions/`, `sandbox/`, `hooks/`, `tools/` subdirectory is **one seam per file** — adding a new permission mode adds a file, not a branch in an existing file.
- The `parity/` directory mirrors claw-code's 9 lanes. Each lane is a single TOML file describing the parity test, the canonical behavior, and the result. CI runs all nine on every commit.
- The `tools/task.ts` and mesh-related logic live in **Package 3: `@envoymesh/envoy-harness-adapter`**, not in envoy-harness itself. envoy-harness's `tools/` does NOT include the task tool — the task tool requires a mesh connection. envoy-harness is mesh-agnostic; the adapter brings the mesh.

#### The other two packages

```
Package 2: @envoymesh/protocol       (lives in EnvoyMesh's monorepo, versioned, published)
├── src/agent-adapter.ts             # AgentAdapter interface, manifest/result/verdict schemas
├── test/                            # contract tests — both envoy-harness and EnvoyMesh pass these
└── package.json                     # @envoymesh/protocol

Package 3: @envoymesh/envoy-harness-adapter  (lives in EnvoyMesh's monorepo, ~500 LoC)
├── src/index.ts                     # public API
├── src/adapter.ts                   # implements AgentAdapter for envoy-harness
├── src/manifest-broadcaster.ts      # signs + sends CapabilityManifest via libp2p
├── src/chain-submit.ts              # submits a task to the chain orchestrator
├── src/verdict-reader.ts            # reads VerdictEntry from ArbitrationStore
├── src/reputation-book.ts           # 3-tuple reputation book (local view)
├── src/mesh-local-runner.ts         # runs a skill on this node, used by the adapter
├── src/cli-shim.ts                  # `envoy task "..."` is intercepted here when adapter is loaded
└── test/                            # integration tests with both envoy-harness and a mock EnvoyMesh
```

**Why split this way**:
- envoy-harness (Package 1) has zero mesh knowledge. Users running it standalone never load a mesh adapter.
- The adapter (Package 3) is the ONLY place that knows about libp2p, mesh broadcasts, and chain submission.
- The contract (Package 2) is small, stable, versioned, and has tests on both sides.

If a user wants envoy-harness in their mesh-like project (not EnvoyMesh), they write their own Package 3 — ~500 LoC, against a stable contract.

---

## 19. The CLI surface (v0)

```
envoy [flags] [prompt-file | -]

Flags:
  --profile <name>              # Permission profile (default: workspace-write in trusted dirs, read-only otherwise)
  --sandbox <mode>              # read-only | workspace-write | danger-full-access
  --approval <mode>             # unless-trusted | on-request | granular | never
  --model <id>                  # LLM model identifier (e.g. claude-sonnet-4-6)
  --provider <name>             # LLM provider (openai, anthropic, ollama, custom)
  --plan                        # plan mode: read + plan, no writes
  --json                        # JSON Lines output (machine-readable)
  --quiet                       # suppress human output, only stream-json
  --cwd <path>                  # override cwd
  --max-cost-usd <n>            # cost ceiling (default 5.00)
  --max-turns <n>               # turn limit (default 50)
  --no-mcp                      # disable MCP client (still act as server)
  --no-extensions               # disable envoy-harness extensions
  --resume <session-id>         # resume a previous session
  --fork <session-id>           # fork a previous session at last user turn
  --log <file>                  # log destination (default: $ENVOY_HOME/logs/<session>.log)
  --no-color                    # disable ANSI colors
  --verbose                     # print all hook fires, all validator verdicts

Subcommands:
  envoy task "<objective>"     # submit a sub-task to the mesh (mesh-native)
  envoy hook <event> ...        # manually trigger a hook event
  envoy doctor                  # health check (mirror of codex's "codex doctor")
  envoy profile list            # show available profiles
  envoy profile show <name>     # show profile contents
  envoy self-evolve             # run one cycle of the 5-step self-evolution protocol
  envoy scoreboard show         # show local + federated scoreboard
  envoy broadcast               # manually broadcast a manifest
  envoy agents                  # show discovered AGENTS.md files
  envoy cost                    # show current cost tracker

Slash commands (interactive mode):
  /help                         # list slash commands
  /compact                      # compact session now
  /reload                       # reload config, hooks, AGENTS.md
  /status                       # show session status
  /clear                        # clear the screen
  /exit                         # exit (Ctrl-D also works)
  /diff                         # show pending changes
  /cost                         # show current cost
  /agents                       # show discovered AGENTS.md
  /hooks                        # show registered hooks
  /permissions                  # show current permission state
  /mode [mode]                  # show or change permission mode (session only)
  /approve-once <tool> <input>  # pre-approve one specific tool call
```

**Compatibility with Codex CLI**: `--sandbox`, `--approval`, `--profile`, `--model`, `--provider`, `--json`, `--resume`, `--fork` use the same flag names. A user who knows Codex can use envoy-harness without learning new flags.

**Compatibility with Claude Code**: `--plan`, `--cwd`, `--max-cost-usd`, slash commands use the same names. The hook event names match. The intent is **drop-in mental model**.

### 19.1 What `--resume` and `--fork` actually do

`--resume <session-id>` reads `$ENVOY_HOME/sessions/<id>.jsonl` and continues from the last turn. The session is loaded into memory; the user is in the same mode (if they were in workspace-write, they continue in workspace-write). Cost continues from where it was.

`--fork <session-id>` is the same as `--resume`, but **creates a new session ID** so the original is untouched. The user can experiment in the fork without polluting the original. Useful for "what if I had used a different approach" debugging.

---

## 20. Config schema and layer composition

`$ENVOY_HOME/agent-state/<peer>/config.toml`:

```toml
# envoy-harness v0 config. Mirrors codex's structure where possible.

# === Permission and approval ===

# Two independent axes. Defaults shown.
permission_mode = "read-only"             # read-only | workspace-write | danger-full-access
ask_for_approval = "on-request"           # unless-trusted | on-request | granular | never

# Optional: load a named profile. Overrides the two lines above.
# profile = "work"                        # looks up $ENVOY_HOME/work.config.toml

# Workspace-write specifics.
writable_roots = []                       # paths writable in workspace-write mode; [] = cwd only
network_access = false                    # if true, network is allowed in workspace-write mode
exclude_slash_tmp = true                  # if true, /tmp is writable

# === Sandbox backend ===

# Default backend per platform:
#   Linux:   "linux-landlock"
#   macOS:   "process-fs-namespace"
#   Windows: "none" (only DangerFullAccess)
sandbox_backend = "auto"                  # auto | linux-landlock | process-fs-namespace | none

# === AGENTS.md discovery ===

project_root_markers = [".git"]           # what stops the upward walk
project_doc_max_bytes = 32768            # 32 KB cap on total AGENTS.md
project_doc_fallback_filenames = []      # other names to look for (besides AGENTS.md)
local_override_filename = "AGENTS.override.md"

# === Hooks ===

# Same names as codex/claude-code. Each entry is a handler.
[[hook.PreToolUse]]
match = { tool = "bash" }
command = "echo $TOOL_CALL >> ~/.envoymesh/audit.log"

[[hook.PreToolUse]]
match = { tool = "write" }
module = "~/.envoymesh/hooks/redact-secrets.ts"

[[hook.PostToolUse]]
match = { tool = "*" }
command = "open $RESULT_FILE"

# === MCP servers (consume) ===

[[mcp_servers]]
name = "github"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { GITHUB_TOKEN = "ghp_..." }

# === MCP server (expose envoy-harness) ===

[mcp_server]
enabled = true
port = 7777
expose_tools = ["read", "write", "edit", "bash", "task", "git"]

# === Mesh (MAP) ===

[mesh]
agent_runtime = "envoy-harness"            # ALWAYS envoy-harness here
broadcast_interval_seconds = 150         # 2.5 min, half the manifest TTL
manifest_ttl_seconds = 300

# === Self-evolution (5-step protocol) ===

[self_evolve]
# Strict self-evolution rules. Read `docs/SELF-EVOLUTION.md` for the full protocol.
ruleset_path = "~/.envoymesh/agent-state/<peer>/verifier-rules.json"
scoreboard_path = "~/.envoymesh/agent-state/<peer>/verifier-scoreboard.yaml"
federated_scoreboard_opt_in = false       # opt-in to pulling rules from other envoy-harness peers
contamination_guard = true                # ALWAYS true. Do not disable.
benchmark_frozen_path = "~/.envoymesh/benchmarks/<name>/frozen.yaml"  # required for the protocol

# === Cost ===

cost_ceiling_usd = 5.00
warn_at_usd = 4.00
```

### 20.1 Config layer composition

Configs are loaded from 4 layers, in increasing priority (later wins):

```
1. $ENVOY_HOME/agent-state/<peer>/config.dist.toml    # shipped defaults
2. $ENVOY_HOME/agent-state/<peer>/config.toml         # user config
3. .envoy/config.toml (in cwd, optional)               # project config
4. CLI flags                                          # session overrides
```

The TOML loader merges in order; later keys override earlier ones. **Arrays are not merged — replaced.** This is the principle: predictable, no surprises.

```ts
// src/config/loader.ts (sketch)
export async function loadConfig(peerId: string, cwd: string, cliFlags: CliFlags): Promise<ResolvedConfig> {
  const dist = await tryReadToml(`~/.envoymesh/agent-state/${peerId}/config.dist.toml`)
  const user = await tryReadToml(`~/.envoymesh/agent-state/${peerId}/config.toml`)
  const project = await tryReadToml(path.join(cwd, '.envoy', 'config.toml'))
  const merged = mergeToml(dist, user, project)
  const withCli = applyCliFlags(merged, cliFlags)
  return ResolvedConfigSchema.parse(withCli)
}
```

---

## 21. Test strategy

### 21.1 Unit tests

For every module in §18, at least one test file. Specifically:

- `permissions/mode.test.ts` — all 12 axis combinations resolve correctly.
- `permissions/bash/{read-only,destructive-warning,mode,sed,path,semantics}.test.ts` — each validator's positive and negative cases, including the 200-command fixture.
- `agents-md/discover.test.ts` — cwd, project root, fallback, override, max bytes; the monorepo fixture.
- `hooks/registry.test.ts` — all 12 events; block short-circuits; modify wins; add-context concatenates; middlewares short-circuit.
- `verifier/composite.test.ts` — all combinations of rule verdicts; OR-of-pass, AND-of-fail, default disputed.
- `cost/tracker.test.ts` — model call recorded; cap enforced; warn at threshold; report shape.
- `config/loader.test.ts` — layer composition; CLI override; profile resolution.

### 21.2 Parity tests (claw-code style)

The `parity/*.toml` files become executable tests via a custom test runner. Each lane is a separate test, parallel to claw-code's 9-lane mock parity harness. The `parity/` directory is **the canonical behavior contract**.

Example: `parity/01-bash-validation.toml` (full):

```toml
[meta]
name = "bash-validation"
description = "All 6 bash validators must run on every bash call."
evidence = "claw-code/PARITY.md:67, claw-code/rust/crates/runtime/src/bash_validation.rs"

[test.composition.all_six_run]
command = "ls -la"
expect_validators = ["read-only", "destructive-warning", "mode", "sed", "path", "command-semantics"]
expect_outcome = "allow"

[test.read-only.blocks_write]
mode = "read-only"
command = "echo hello > /tmp/foo"
expect = "block"
reason = "read-only mode cannot write"

[test.sed.blocks_system_path]
command = "sed -i 's/old/new/' /etc/hosts"
expect = "block"
reason = "sed -i on system path blocked"

[test.destructive.warning]
command = "rm -rf /"
expect = "allow-with-warning"
warning_matches = "destructive: targets root"

[test.path.outside_writable_roots]
mode = "workspace-write"
writable_roots = ["/home/alice/project"]
command = "bash"
argv = ["bash", "-c", "echo hi > /etc/foo"]
expect = "block"
reason = "path /etc/foo is outside writable_roots"
```

The runner reads the TOML, executes each test, fails CI if any test fails.

### 21.3 E2E tests

- `envoy --plan` produces a plan.md without writing anything else.
- `envoy` in a git repo creates a branch, commits, and (if configured) opens a PR.
- `envoy` with an MCP server config spawns the server, lists tools, calls one.
- `envoy task "..."` submits a chain step to the mesh (mocked); the orchestrator picks a peer; the result is verified.
- 5-step self-evolution: write a benchmark, run a cycle, observe a `kept` or `reverted` scoreboard entry.
- Resume: kill a session mid-turn, restart with `--resume`, verify the model sees the prior context.

### 21.4 Test data

- A fixture repo with a known AGENTS.md hierarchy (3 levels of nesting, an override).
- A fixture bash command list (200 commands, each labeled `block | warn | allow`).
- A frozen benchmark YAML (50 cases, expected pass rate per verifier rule).
- A mock model server (Anthropic-compatible, like claw-code's `rust/crates/mock-anthropic-service`).

---

## 22. Migration and timeline

### Phase 0 — Empty package (1 day, today)

- Create `packages/envoy-harness/{package.json,tsconfig.json,src/index.ts,README.md}`.
- Add `envoy-harness` as the first enum value in `AgentRuntimeSchema` from the MAP design.
- One PR. Goal: structural commitment.

### Phase 1 — v0 spine (4 weeks, 1 engineer)

- All file skeletons exist; the 6 bash validators are real; the AGENTS.md discovery is real; the hook registry is real; the verifier rule engine is real; the agent loop runs; the CLI takes a prompt and returns a response.
- Tests: parity test for the 6 bash validators, AGENTS.md discovery, hook events, agent loop on a mock model.

### Phase 2 — Mesh-native (4 weeks)

- EnvoyHarnessAdapter implements the full MAP surface.
- Manifest broadcast works.
- `envoy task` submits chain steps to the mesh.
- 3-tuple reputation book is local-only; arbitration reads work.

### Phase 3 — Self-evolution (3 weeks)

- 5-step protocol scaffold complete.
- First cycle runs in shadow mode (no commit).
- Owner-key-signed scoreboard entries.
- Federated scoreboard opt-in (off by default).

### Phase 4 — Production-grade (ongoing)

- LSP client (parity with claw-code lane 8).
- Team + cron (parity with claw-code lane 6, if useful).
- Trace observability UI.
- Per-call approval callback (Penguin style).
- Cross-agent verification (MAP §CrossAgentDisagreementVerifier).

**Total to v0 ship-ready: ~12 weeks, 1-2 engineers.**

---

## 23. Decision summary (what we decided and what we didn't)

### Decisions made

| # | Decision | Rationale |
|---|---|---|
| 1 | Default `permission_mode = "read-only"` | First-impressions matter; safe default |
| 2 | Permission and approval are separate axes | 12 cells, not 3; matches codex |
| 3 | AGENTS.md discovery: walk-up + concat, not first-found | Monorepos have multiple docs |
| 4 | Bash has 6 validators, not 1 | Bash accidents are common; composition is the story |
| 5 | 12 hook events, fixed set | Mental-model portability + auditability |
| 6 | MCP is bidirectional | Network effects |
| 7 | Sub-agents map to mesh chain steps | Mesh-native |
| 8 | Self-evolution target is the verifier ruleset + AGENTS.md | Both are persistent identity |
| 9 | Cost is tracked per turn, not per session | User sees growth |
| 10 | Owner keys sign everything cross-node | Cross-node verification |
| 11 | Tools never throw across dispatch | Errors visible in model context |
| 12 | Config is TOML, not JSON or YAML | Match codex + cargo |
| 13 | TypeScript, not Rust | Match EnvoyMesh host |
| 14 | envoy-harness is *one of* adapters, not the system agent | Avoid capture; ensure open competition |
| 15 | `parity/` directory as canonical behavior contract | claw-code pattern works |

### Decisions deferred

| # | Decision | Why deferred | When |
|---|---|---|---|
| D1 | Which local model is the verifier LLM by default? | Depends on user's model choices | Phase 4 |
| D2 | Web UI vs TUI-only for v0? | TUI is enough; web is for after launch | Post v0 |
| D3 | Multi-agent workspace sharing? | Big design lift; not in scope for v0 | Post v0 |
| D4 | `lsp-client` parity with claw-code lane 8? | Useful but not blocking | Phase 4 |
| D5 | Should hooks support async/await directly? | Currently fire-and-forget; sync may be wrong | Phase 4 |

---

## 24. Open questions

1. **Language: TypeScript or Rust?** Codex is Rust; claw-code is Rust port; envoy-harness's host (EnvoyMesh) is TypeScript. **TS keeps the type system aligned with the rest of the mesh.** Recommend TS for v0; consider a Rust port if perf becomes a constraint.

2. **Provider abstraction layer.** envoy-harness needs to talk to OpenAI, Anthropic, Ollama, vllm, custom endpoints. Borrow from Pi's `pi-ai` (unified multi-provider API) or write a thin adapter? Recommend: thin adapter, since envoy-harness's needs are smaller than Pi's.

3. **Local model support depth.** Codex supports Ollama out of the box. Should envoy-harness ship its own Ollama recipes, or document that users use OpenClaw for that? Recommend: ship the most common (Ollama); delegate the long tail to OpenClaw.

4. **What "danger-full-access" actually means in a mesh context.** With mesh-native, an agent can spawn a sub-agent on another node. The sub-agent runs in the local sandbox of the remote node, *not* the requester's sandbox. **Is `danger-full-access` scoped per-node, or per-mesh?** Recommend: per-node. The requester's `danger-full-access` does not transfer.

5. **Federated self-evolution: pull model or push model?** Today: pull (peer B fetches peer A's rule). Should there be a push model (peer A's rule is automatically offered to all envoy-harness nodes running the same runtime)? Recommend: pull, with explicit opt-in. Push is later if pull works.

6. **Cost attribution across mesh.** When a chain step runs on a remote node, the cost is paid by the requester. But the verifier LLM (for cross-agent verification) is paid by whom? Recommend: the requester (matches chain-budget-ledger's reserve/commit semantics).

7. **Hook decision semantics for add-context.** Today: all `add-context` are concatenated. Should they be per-tool, per-session, per-event? Recommend: current behavior (concat) is fine for v0; revisit if users complain.

---

## 25. Pointers

### Files in this design that come from specific real codebases

| Concept | Source | Where in the source |
|---|---|---|
| AGENTS.md discovery | codex | `codex-rs/core/src/agents_md.rs:1-90` |
| `AGENTS.override.md` | codex | `codex-rs/core/src/agents_md.rs:38-39` |
| `project_doc_max_bytes` budget | codex | `codex-rs/core/src/agents_md.rs:74-77` |
| `SandboxMode` enum (3 levels) | codex | `codex-rs/protocol/src/config_types.rs:86-96` |
| `AskForApproval` enum (4 levels) | codex | `codex-rs/protocol/src/protocol.rs:915-939` |
| 6 bash validators (named) | claw-code | `claw-code/PARITY.md:67` |
| `PermissionEnforcer` | claw-code | `claw-code/rust/crates/runtime/src/permission_enforcer.rs:1-50` |
| 9-lane parity harness | claw-code | `claw-code/PARITY.md:42-52` |
| 12 hook event names | codex | `codex-rs/core/src/hook_runtime.rs:8-32` |
| Profile selection | codex | `codex-rs/protocol/src/config_types.rs:98-130` |
| `TaggedError` + `Result` | pi | `pi/packages/agent/src/harness/agent-harness.ts:28-55` |
| 5-step self-evolution | penguin | `penguin-harness/examples/self-improving-agent/self-evolve.ts` |
| MAP protocol (manifest/result/verdict) | envoymesh-design (previous) | `envoymesh-design/improving-agent-network.en.md` §4 |
| 3-tuple reputation | envoymesh-design (previous) | `envoymesh-design/improving-agent-network.en.md` §7 |
| Cross-agent verification | envoymesh-design (previous) | `envoymesh-design/improving-agent-network.en.md` §8 |
| Formal effect tracking (for future) | deepseek | `deepseek-harness/vendor/cordis/` |

### Inspirations and adjacent work

- **DeepSeek-Harness** for the long-term vision (formal effect tracking, capability seams)
- **Penguin-Harness** for the 5-step self-evolution protocol, scoreboard, contamination guard
- **Pi** for minimal extension model, TaggedError, Agent Skills standard
- **Codex CLI** for the 3-mode sandbox, 4-mode approval, AGENTS.md discovery, hook event names
- **Claude Code / claw-code** for plan mode, permission UX, MCP integration, sub-agents, 9-lane parity harness
- **EnvoyMesh's own MAP design** for the wire protocol envoy-harness speaks natively
