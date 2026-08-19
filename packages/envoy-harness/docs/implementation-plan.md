# envoy-harness implementation plan

> **Purpose.** The single source of truth for "what we did, what
> we are doing, what we plan to do." Use this to onboard,
> resume after a break, and decide what's next.
>
> **Companion to `docs/design.en.md`.** The design says *what*
> and *why*. This file says *what shipped*, *where it lives*,
> and *what's still open*. The boundary doc
> (`docs/boundary.en.md`) says *what belongs in envoy-harness vs
> EnvoyMesh*; this file assumes the boundary.
>
> **Status as of last commit:** F17.2 done on `phase-1/types`.
>
> - **Total:** 829 tests across 54 files (envoy-harness 737 / 44
>   files + envoy-harness-adapter 92 / 10 files). All passing.
> - **Typecheck:** clean (`pnpm -r typecheck`).
> - **Phase 1 (v0 spine):** ✅ done (Chunks 1-4d, 220 tests)
> - **Phase 2 (Mesh-native):** ✅ done (F7 + F8, 540 tests)
> - **Phase 3 (Self-evolution):** ✅ done (5a-5e + F6, 110 tests)
> - **Phase 4 (Production-grade):** ✅ done (F9.1-F9.5, 5 sub-chunks)
> - **Phase 5 (Mesh-native sub-agents):** ✅ done (F10.1-F10.6, 8 sub-chunks)
> - **Phase 6 (REPL):** ⏳ in progress (F17.1 + F17.2 done; F17.3 + F17.4 pending)
>
> **How to read this document.** §1 is project context (1 page).
> §2 is the status snapshot (test count + per-module inventory).
> §3 is the chronological "done work" record (per-commit, by phase).
> §4 is the architectural invariants (the 7 things we hold). §5 is
> the in-flight risks and known issues. §6 is the planned work
> (Phase 6+). §7 is the sub-chunk archive (the F6 archive; F10
> plans are kept in §6.6 for in-context reference). §8 is the
> "how to extend" recipes. §9 is references. §10 is the change
> log (chronological).
>
> **Top of doc:** the design discussion (what & why) for Phase 5 — the mesh-native sub-agents design rationale + type surface — now lives in [`docs/design.en.md`](./design.en.md) §10.3. The *implementation record* (what shipped) is in §3 (chronological by commit). The *plan-with-sub-chunks* (the F10.2, F10.3, etc. plans) is in §6.6.
>
> **Branch:** all work is on `phase-1/types`. 9 unpushed commits as of the latest (F10.6 + 2 doc restructure + 2 design/Phase-5 + README/F17 plan + F17.1 + F17.2); Phase 5 complete, Phase 6 (REPL) in progress (F17.1 + F17.2 done; F17.3 + F17.4 pending).

---

## 1. Project context

**envoy-harness** is EnvoyMesh's home-team agent harness.
Production-grade CLI agent, EnvoyMesh-native, independently
runnable. The full design is in `docs/design.en.md` (English
source of truth) and `docs/design.zh.md` (Chinese mirror).

The harness is the *first* of three packages in the
`@envoymesh/envoy-harness` repo family:
- **Package 1 (this branch):** the standalone harness.
  Zero EnvoyMesh-internal deps. Testable in isolation.
- **Package 2** (separate work): `@envoymesh/protocol` —
  the wire types (MAP protocol). Lives in `allenpeng0705/EnvoyMesh`.
- **Package 3** (planned): `@envoymesh/envoy-harness-adapter` —
  the bridge between the harness and the mesh. Translates local
  types to wire types; broadcasts manifests; receives tasks.

Per design §1.3, the four design targets are non-negotiable:
1. **EnvoyMesh-native** (the Adapter Package 3 satisfies this).
2. **Independently runnable** (Package 1 has no EnvoyMesh deps).
3. **Easy to integrate elsewhere** (the `ModelAdapter` /
   `HookRegistry` / `ToolRegistry` interfaces are the seams).
4. **Self-contained, fully independently testable** (the test
   suite is hermetic; 305 tests, no network, no real LLMs).

---

## 2. Status snapshot

| Phase | Scope | Status | Tests |
|-------|-------|--------|-------|
| **Phase 0** | Empty package skeleton | ✅ done (`4813d8c`) | 1 |
| **Phase 1** | v0 spine (4 weeks) | ✅ done (Chunks 1-4d) | 220 |
| **Phase 2** | Mesh-native (4 weeks) | ✅ done (F7 + F8) | 540 |
| **Phase 3** | Self-evolution (3 weeks) | ✅ done (5a-5e + F6) | 110 |
| **Phase 4** | Production-grade (5 sub-chunks: F9.1 + F9.2 + F9.3 + F9.4 + F9.5) | ✅ done | +130 (vs Phase 3) |
| **Phase 5** | Mesh-native sub-agents (8 sub-chunks: F10.1-F10.6) | ✅ done | +94 (vs Phase 4) |
| **Phase 6** | Interactive REPL (2 sub-chunks done: F17.1 + F17.2; 2 pending: F17.3 + F17.4) | ⏳ in progress | +38 (F17.1 + F17.2) |

**Cumulative:** 829 tests across 54 files (envoy-harness 737 + envoy-harness-adapter 92), all passing.
Typecheck clean (`pnpm -r typecheck`).

**Per-module test inventory (44 envoy-harness files + 10 envoy-harness-adapter files = 829 tests):**

#### envoy-harness (Package 1, 737 tests / 44 files)

| Module | Tests | File | What it covers |
|--------|-------|------|----------------|
| Smoke | 1 | `test/smoke.test.ts` | Version export |
| Type system (§5) | 43 | `test/types.test.ts` | Every schema + cross-field |
| Bash validators (§6) | 47 | `test/permissions-bash.test.ts` | 200-command parity fixture |
| Hook registry (§8.2-3) | 42 | `test/hooks-registry.test.ts` | Middleware, modify, decision composition, runners |
| AGENTS.md discovery (§9) | 24 | `test/agents-md.test.ts` | 5-step algorithm, fixtures |
| Tool registry (§10) | 12 | `test/tools-registry.test.ts` | Register, lookup, duplicate error |
| bash tool | 12 | `test/tools-bash.test.ts` | Permission modes, output capture, timeout, abort |
| read_file tool | 5 | `test/tools-read-file.test.ts` | Success, maxBytes, ENOENT, EISDIR |
| Session | 10 | `test/session.test.ts` | Append-only, content-block copy, newSessionId uniqueness |
| Agent loop (§3.4) | 17 | `test/agent.test.ts` | Single-turn, tool flow, hook integration, limits, model error |
| CLI runner (§19) | 32 | `test/cli.test.ts` | argv parsing (run + self-evolve), runner, error paths |
| CLI provider dispatch (F7.5) | 28 | `test/cli-provider-dispatch.test.ts` | --provider openai/anthropic/deepseek/ollama; --max-cost-usd |
| E2E | 3 | `test/e2e.test.ts` | read → run → summarize (direct + via CLI) |
| Verifier rule engine (§12) | 26 | `test/verifier.test.ts` | Each of 6 rules, runVerifierRules, combineVerdicts |
| Scoreboard data (§13) | 16 | `test/scoreboard.test.ts` | Schemas, file I/O, hash, sign |
| Self-evolve (§13.1) | 19 | `test/self-evolve.test.ts` | Contamination guard, parseHypothesis, 5 steps |
| Self-evolve e2e (§13) | 4 | `test/self-evolve-e2e.test.ts` | Frozen benchmark, shadow cycle, end-to-end contamination |
| Federated pull (F6.1) | 11 | `test/federated.test.ts` | PeerSource, LocalPeerSource, filter+verify, opt-in default |
| Federated local gate (F6.2) | 6 | `test/federated-local-gate.test.ts` | runOneCycleAgainst, adopt() splitting |
| Federated adoptions (F6.3) | 7 | `test/federated-adoptions.test.ts` | appendAdoption, audit trail (kept + rejected) |
| Cost tracking (F7.1) | 18 | `test/cost.test.ts` | TokenPrice, DEFAULT_PRICING, CostTracker, computeCost, model override |
| LLM OpenAI (F7.2) | 58 | `test/llm-openai.test.ts` | OpenAIAdapter: split/format, request shape, response parsing, errors, stop-reason |
| LLM Anthropic (F7.3) | 45 | `test/llm-anthropic.test.ts` | AnthropicAdapter: split/format, request shape, response parsing, errors, stop-reason |
| LLM DeepSeek (F7.4) | 9 | `test/llm-deepseek.test.ts` | DeepSeekAdapter: defaults, overrides, end-to-end response parsing |
| Per-call approval (F9.1) | 10 | `test/per-call-approval.test.ts` | `ask` HookDecision, AskHandler, allow/deny/modify, default deny |
| LSP types + tools (F9.2.1) | 21 | `test/lsp.test.ts` | LspClient interface, LspManager, LspLocation/Hover/Diagnostic |
| LSP stdio client (F9.2.2) | 30 | `test/lsp-stdio.test.ts` | StdioLspClient: JSON-RPC over stdio, Content-Length framing, FakeStdio |
| LSP tools (F9.2.3) | 13 | `test/lsp-tools.test.ts` | makeLspTools: lsp_definition/references/hover/diagnostics |
| Trace (F9.4) | 8 | `test/trace.test.ts` | TraceEvent, NullTracer, JsonLinesTracer (WritableStream) |
| Trace in agent (F9.4) | 10 | `test/trace-agent.test.ts` | 5 emit points in Agent.run(), tool_call/tool_result for unknown tools |
| Team TOML (F9.3) | 17 | `test/team-toml.test.ts` | parseTeamToml, TomlParseError, toTeamConfig, toAgentSpec |
| Team runner (F9.3) | 8 | `test/team-runner.test.ts` | Team.runOnce, topological sort, per-agent failure detection |
| Sub-agent types (F10.1.1) | 10 | `test/subagent-types.test.ts` | SubagentInput, SubagentResult, MeshSubmitter, NoopMeshSubmitter |
| Sub-agent local (F10.1.2) | 13 | `test/subagent-local.test.ts` | LocalMeshSubmitter, defaultBuildSubagentFactory, NEW session per call |
| Sub-agent tool (F10.1.3) | 15 | `test/subagent-tool.test.ts` | makeTaskTool, TaskInputSchema, MeshSubmitter arg vs options object |
| Sub-agent e2e (F10.1.4) | 6 | `test/subagent-e2e.test.ts` | Parent's tool list includes task; full happy path; session independence |
| Sub-agent parallel (F10.2.1) | 8 | `test/subagent-parallel.test.ts` | Auto-detect "all task" → Promise.all; maxSubagents cap (refuse all when exceeded) |
| Sub-agent signer (F10.3.1) | 7 | `test/subagent-signer.test.ts` | SubagentResultSigner seam; LocalMeshSubmitter.signer option |
| Sub-agent cost + trace (F10.5) | 8 | `test/subagent-cost-trace.test.ts` | addSubagentCost; parent tracer receives sub-agent events |
| Sub-agent routing hint (F10.3.3) | 4 | `test/subagent-routing-hint.test.ts` | RoutingHint type, additive field, host-only seam |
| Sub-agent fan-out (F10.4.1) | 11 | `test/subagent-fan-out.test.ts` | FanOutSpec, FanOutRegistry, aggregateFanOutResults, task tool fan-out |
| Sub-agent subagentOf (F10.6) | 5 | `test/subagent-subagent-of.test.ts` | TraceBase.subagentOf, parent events omit, sub-agent events carry |
| REPL loop (F17.1) | 13 | `test/repl-loop.test.ts` | --repl flag; /quit + /exit + EOF exit; blank-line skip; unknown-slash placeholder; agent reuse across turns; turns + totalCostUsd accounting |
| REPL commands (F17.2) | 25 | `test/repl-commands.test.ts` | parseCommandLine; ReplCommandRegistry; dispatchCommand; 9 built-ins (help/model/provider/sandbox/approval/clear/cost/status/quit); customCommands; built-in wins on collision |

#### envoy-harness-adapter (Package 3, 92 tests / 10 files)

| Module | Tests | File | What it covers |
|--------|-------|------|----------------|
| Skills catalog (F8.1) | 19 | `test/skills.test.ts` | ENVOY_HARNESS_SKILLS, getToolsForSkill, isReadOnlySkill |
| Local ↔ wire translation (F8.3) | 17 | `test/translation.test.ts` | TOOL_CALL_SCHEMA_REF, TOOL_RESULT_SCHEMA_REF, localToWireBlock/Content/Metrics/Result |
| EnvoyHarnessAdapter (F8.2+4+5+6) | 13 | `test/adapter.test.ts` | defaultBuildAgentFactory, EnvoyHarnessAdapter, buildManifest |
| Sign entry (F8.4+) | 7 | `test/signing.test.ts` | defaultSignResult, defaultSignResultFromKeyPair, real Ed25519 |
| Local verifier (F8.6+) | 8 | `test/verify.test.ts` | runLocalVerifier, runLocalVerifierOnLocal, 6 default rules wired |
| Cross-agent verification (F9.5.1) | 4 | `test/cross-verify.test.ts` | CrossVerifyFn, defaultCrossVerify |
| Cross-verify adapter (F9.5.2) | 5 | `test/cross-verify-adapter.test.ts` | EnvoyHarnessAdapter.verify() concatenates local + cross |
| Integration (F8) | 7 | `test/integration.test.ts` | end-to-end adapter behavior |
| RemoteMeshSubmitter (F10.3.2) | 10 | `test/remote-mesh-submitter.test.ts` | RemoteSubmitterTransport seam; thin wrapper over injected transport |
| Smoke | 2 | `test/smoke.test.ts` | Package version export |

---

## 3. Done work (chronological, by commit)

> **This section is the implementation history.** Each
> subsection is a single commit (or a small related group).
> For the high-level "what shipped" per phase, see the
> status table at the top of this doc and §2.

### Phase summary

| Phase | Scope | Sub-chunks | Tests | Done |
|-------|-------|------------|-------|------|
| **Phase 0** | Empty package skeleton | 1 commit | 1 | ✅ |
| **Phase 1** | v0 spine (4 weeks) | Chunks 1-4d (5 commits) | 220 | ✅ |
| **Phase 2** | Mesh-native (4 weeks) | F7 (5) + F8 (4) + F8 polish (1) | 540 | ✅ |
| **Phase 3** | Self-evolution (3 weeks) | Chunks 5a-5e (5 commits) + F6 (4) | 110 | ✅ |
| **Phase 4** | Production-grade | F9.1-F9.5 (5 sub-chunks) | +130 | ✅ |
| **Phase 5** | Mesh-native sub-agents | F10.1-F10.6 (8 sub-chunks) | +94 | ✅ |

**Phase-by-phase narrative:**

- **Phase 0 (1 commit)** — empty package. The structural commitment
  (package.json, tsconfig, vitest, AGENTS.md, CI). The AgentRuntime
  enum is anchored to envoy-harness in the MAP protocol contract.
- **Phase 1 (Chunks 1-4d, 5 commits, 220 tests)** — the v0 spine.
  Type system, bash validators, AGENTS.md discovery, hook registry,
  tool registry, Agent loop, CLI runner, verifier rule engine.
  The "spine" of every later feature.
- **Phase 2 (F7 + F8 + F8 polish, 10 sub-chunks, 540 tests)** —
  mesh-native. F7 ships real LLM adapters (OpenAI, Anthropic,
  DeepSeek) + cost tracking + CLI provider dispatch. F8 ships
  `envoy-harness-adapter` (Package 3, the MAP bridge), tools
  mapping, local ↔ wire translation, Ed25519 signing, local
  verifier rules wired. The monorepo restructure happens here.
- **Phase 3 (5a-5e + F6, 9 sub-chunks, 110 tests)** — self-evolution.
  Scoreboard data layer, `SelfEvolve` class with the 5-step
  protocol, frozen benchmark + shadow cycle e2e, `envoy
  self-evolve` CLI. F6 adds federated scoreboard (PeerSource,
  local 5-step gate, adoption records, `--pull` CLI flag).
- **Phase 4 (F9.1-F9.5, 5 sub-chunks, +130 tests)** — production-grade.
  Per-call approval (Penguin-style ask/allow/deny/modify);
  LSP integration (client + manager + 4 tools); `--json` trace
  mode (5 emit points in Agent.run + JsonLinesTracer);
  team + cron (hand-rolled minimal TOML reader, topological
  sort, per-agent failure detection); cross-agent verification
  (`CrossVerifyFn` + `defaultCrossVerify`).
- **Phase 5 (F10.1-F10.6, 8 sub-chunks, +94 tests)** — mesh-native
  sub-agents. The full sub-agent lifecycle: spawn (F10.1:
  `MeshSubmitter` + `LocalMeshSubmitter` + `task` tool) → route
  (F10.2: parallel fan-out + `maxSubagents` cap) → trust
  (F10.3.1: `SubagentResultSigner`; F10.3.2: cross-node
  `RemoteMeshSubmitter`; F10.3.3: federated routing hint) →
  fan-out (F10.4.1: `FanOutSpec` capability-driven fan-out) →
  aggregate (F10.5: sub-agent cost + trace flow to parent) →
  annotate (F10.6: `subagentOf` trace annotation). The
  `LocalMeshSubmitter` v0 ships unsigned (no trust boundary for
  in-process); the future `RemoteMeshSubmitter` will sign
  with the worker's owner key.

**Phase milestones (per design §22):**

- **Phase 1 milestone:** "All file skeletons exist; the 6 bash
  validators are real; the AGENTS.md discovery is real; the hook
  registry is real; the verifier rule engine is real; the agent
  loop runs; the CLI takes a prompt and returns a response." —
  All 7 done.
- **Phase 3 milestone:** "5-step protocol scaffold complete. First
  cycle runs in shadow mode (no commit). Owner-key-signed
  scoreboard entries. Federated scoreboard opt-in (off by
  default)." — 4 of 4 done (5a-5e + F6).
- **Phase 5 (effective) milestone:** mesh-native sub-agent runtime
  is feature-complete: spawn, route, trust, fan-out, aggregate,
  annotate. Cross-node `RemoteMeshSubmitter` is the seam (Package
  3); the actual libp2p + Ed25519 + mesh protocol lives in
  EnvoyMesh.

### Phase 0 — empty package (`4813d8c`)
**Scope:** the structural commitment. 12 files:
`package.json`, `tsconfig.json`, `vitest.config.ts`,
`src/index.ts`, `test/smoke.test.ts`, `.gitignore`, `.nvmrc`,
`LICENSE` (Apache-2.0), `README.md`, `README-zh.md`,
`AGENTS.md`, `.github/workflows/ci.yml`. `envoy-harness` is
the first enum value in `AgentRuntimeSchema` from MAP.

### Phase 1, Chunk 1 — local type system (`e845c30`)
**§5.1-§5.6 of the design.** `src/types.ts` (387 lines).
- Permission and approval (two axes: 3 × 4 = 12 distinct states).
- Sandbox (backends + resolved `SandboxPolicy`).
- Bash validators (input/verdict types).
- 12 hook event names (matches `codex-rs/core/src/hook_runtime.rs`).
- AGENTS.md types (doc, loaded).
- `Verdict` and `VerdictEntry` (mirrors the wire types).

**Key decision:** local types mirror wire types in
`@envoymesh/protocol/agent-adapter` (same values, same regex)
but defined locally per design target #2/#4 (zero
EnvoyMesh-internal deps). Adapter (Package 3) is the bridge.

### Phase 1, Chunk 2 — 6 bash validators (`29db17f`)
**§6 of the design.** `src/permissions/bash/` with 6 files
(read-only, destructive-warning, mode, sed, path, semantics)
+ `index.ts` composition. 200-command parity fixture in
`test/fixtures/bash-commands.ts` (12 groups).

**Composition:** two passes. First pass catches blocks
(short-circuit). Second pass surfaces warnings (first wins).

**Self-review fixes (post-initial-write):**
- The destructive-warning regex was matching `2>` (false
  positive on stderr redirect) — rewrote to require `>`
  preceded by start/whitespace/`;|(`/`.
- Added missing write ops: chown, ln, chgrp, rmdir,
  truncate, fallocate, mktemp, install, rsync.
- `~` expansion added as a real fix: `path.resolve(cwd,
  '~/foo')` doesn't expand tilde; added `expandTilde()`
  using `os.homedir()`.

### Phase 1, Chunk 3 — AGENTS.md + hook registry (`a211af2`)
**§8 + §9 of the design.**

`src/agents-md/discover.ts` (256 lines) — verbatim Codex
pattern. 5-step algorithm:
1. Find project root (walk up looking for marker).
2. Collect doc paths leaf-first.
3. Read each, respecting `maxBytes` (truncate the last that
   would overflow; never start a new one).
4. Read the override (last, so it wins on conflicts).
5. Assemble with origin/path HTML comments and separator.

`src/hooks/registry.ts` (260 lines) — `HookRegistry` class.
`on()` accepts both `HookFn` (in-process function) and
`HookHandler` (declarative: shell command or TS module).
Decision composition: first block short-circuits; all
add-context concatenate; last modify wins (PostToolUse only);
otherwise continue.

`src/hooks/runner.ts` (217 lines) — `runShellHandler`
(spawns `sh -c`, parses stdout as JSON or falls back to
plain text as add-context) and `runModuleHandler` (dynamic
imports a TS module, calls its default export).

**Self-review fix:** API was originally `on(event, HookHandler)`
only; tests required inline functions. Refactored to
`on(event, HookFn | HookHandler)`. `declarativeToFn` returns
a sync closure with lazy dynamic import — keeps the registry
tree-shakable when no declarative handlers are registered.

### Phase 1, Chunk 4a — tool registry + ModelAdapter + Session (`bebd30f`)
**§3.2, §3.4, §10.**

`src/tools/types.ts` — `Tool` interface (zod-typed params),
`ToolCall`, `ToolResult`, `ToolContext`, plus `Message` /
`ContentBlock` / `Role` for the transcript. Generics give
typed args: `Tool<TParams>` infers args via `z.infer<TParams>`,
so `execute` needs no cast.

`src/tools/registry.ts` — `ToolRegistry` class with
register/get/has/names/list/size/unregister/clear.
`DuplicateToolError` on double register.

`src/model.ts` — `ModelAdapter` interface with `complete()`
and `ModelResponse` (content + `stopReason`:
`end_turn | tool_use | max_tokens | stop_sequence`).
`CompleteInput` bundles messages, tools, model, temperature,
maxTokens for future extensibility.

`src/session.ts` — `Session` interface + `InMemorySession`.
Append-only transcript; `id` and `metadata` are read-only;
content blocks are copied (caller can't mutate after append).
`newSessionId()` uses `crypto.randomUUID`.

**Key decision:** `Tool<TParams>` is generic; `register()`
accepts `Tool<z.ZodTypeAny>` (type erasure on the registry's
internal Map). Heterogeneous tools coexist; the model's
tool_use payload contains the args in the canonical shape.

### Phase 1, Chunk 4b — built-in tools + Agent loop (`37079cb`)
**§3.4, §10.**

`src/tools/builtin/read-file.ts` — UTF-8 read with optional
`maxBytes` truncation (default 1 MB). ENOENT, EISDIR, EACCES
become `isError: true` results with a useful message.

`src/tools/builtin/bash.ts` — builds a `SandboxPolicy` from
the session's `permissionMode`, runs `validateBash` (the
6-validator composition), and spawns `sh -c`. Honors
verdict.kind: block returns isError without spawning;
allow-with-warning prefixes the result; allow runs. Per-stream
output cap (default 1 MB), per-call `timeoutMs`, and
agent-level `abortSignal` all kill the child with `SIGKILL`.

`src/agent.ts` — `Agent` class. The 5-step loop per design §3.4:
model → assistant message → extract tool calls → for each:
PreToolUse hook → arg validation (zod) → execute (try/catch) →
PostToolUse hook (honors modify) → tool result. Loops until
no tool calls, max_tokens, max iterations, or abort. Stops
short-circuit on model errors (synthesizes an assistant
message so the user sees the error in the transcript).

`test/fixtures/fake-model.ts` — scripted `ModelAdapter` for
tests. Not exported from the public API.

**Self-review fix:** `Agent.abort()` is a method, not a
free function. The runner's `abortAgent(agent)` was awkward
(private field access). Replaced with a public `abort()`.

**Bug fix during testing:** `FakeModel` initially stored the
input by reference; later mutations of the session leaked
into recorded inputs. Fixed by snapshotting messages at call
time (deep copy of role + content).

### Phase 1, Chunk 4c — CLI runner + e2e (`4d104cc`)
**§19 of the design.**

`src/cli/argv.ts` (now 473 lines after Phase 3 refactor) —
v0 flag set: `--sandbox`, `--approval`, `--model`,
`--provider`, `--cwd`, `--max-turns`, `--max-cost-usd`,
`--resume`, `--fork`, `--plan`, `--json`, `--quiet`,
`--no-color`, `--verbose`, `--help`, `--version`. Unknown
flags throw `ArgvError`. Valued flags consume the next arg;
missing values throw.

`src/cli/run.ts` (366 lines) — CLI runner. Parses argv →
resolves prompt (positional literal, `-` for stdin, or file
path if it exists) → builds `Agent` with `BUILTIN_TOOLS`,
`InMemorySession`, default `HookRegistry` → runs the loop →
prints text content. Exit codes per BSD sysexits: 0 (OK),
64 (USAGE), 65 (DATAERR), 66 (NOINPUT), 1 (ERROR). Model
is injected (Phase 1: no built-in provider).

`bin/envoy-harness.ts` — the binary. Catches `CliError`,
prints to stderr, exits with the code. Shebang is
`npx tsx` so it runs directly from source.

`package.json` — added `bin/envoy-harness`, `tsx` devDep,
`pnpm envoy` script for dev usage.

### Phase 1, Chunk 4d — verifier rule engine (`16a6bf1`)
**§12.1, §12.2 of the design.**

`src/verifier/types.ts` — `VerifierRule` interface (async,
returns `Verdict | null`) and the two composition primitives:
`runVerifierRules` (run all, filter nulls) and
`combineVerdicts` (first fail > disputed (empty) > all-pass
average > partial). `concatText` helper for the keyword-overlap
rule.

`src/verifier/rules/index.ts` (278 lines) — the 6 default
rules from design §12.1:
1. `non-empty-content` — pass on any block, fail on empty.
2. `output-matches-objective` — keyword overlap ≥ 50% = pass.
3. `sandbox-respected` — flags EACCES/EPERM in non-error results.
4. `approval-respected` — v0 passes with low confidence
   (deferred to sandbox-respected for the same class of violation).
5. `mesh-task-shape` — TS-typed; v0 only checks non-empty.
6. `cost-reasonable-for-work` — abstains (no metrics in v0).
`DEFAULT_RULES` is the v0 set; the 5-step self-evolution
protocol (§13) edits this list.

`Agent.run()` now populates `messages` (full transcript) and
`sandboxPolicy` (effective policy) on `AgentResult`. The
verifier reads these. The bash tool and the agent
independently derive the policy from the session's
permissionMode via a shared mapping (cross-checked at test
time).

### Phase 3, Chunk 5a — scoreboard data layer (`f8b77ef`)
**§13 data.**

`src/scoreboard/types.ts` — `ScoreboardEntry` (the
audit-trail record), `Scoreboard` (list), `VerifierRuleset`
(hash + rules), `Benchmark`, `BenchmarkTask`, `BenchmarkResult`.
`ScoreboardEntry` is the on-disk format; `Benchmark` is
the frozen evaluation set.

`src/scoreboard/storage.ts` — `readScoreboard`,
`writeScoreboard`, `appendEntry` (atomic temp+rename),
`readBenchmark`, `writeBenchmark`. Empty file returns empty
scoreboard (a fresh peer has no history). `hashRuleset` is
order-independent (canonical sort). `signEntry` is SHA-256
over the canonical JSON payload (v0; Ed25519 in a later
chunk when the owner key lands).

Added the `yaml` package dependency.

### Phase 3, Chunk 5b — SelfEvolve class + 5-step protocol (`1dc8009`)
**§13.1 of the design.**

`src/scoreboard/self-evolve.ts` (595 lines) — the 5-step
protocol:

1. **SNAPSHOT** — copy the current state into a versioned
   directory.
2. **HYPOTHESIZE** — `HypothesisProvider` reads recent failures
   and proposes a new ruleset.
3. **CANDIDATE** — write the proposed ruleset to
   `v<version>.candidate.json`.
4. **EVALUATE** — run the benchmark against both the current
   ruleset (baseline) and the candidate.
5. **COMMIT / REVERT** — keep iff `after.passRate > before.passRate`
   (strict greater; ties revert). Append a `ScoreboardEntry`.

`HypothesisProvider` interface — the seam where the optimizer
lives. Two implementations: `ModelHypothesisProvider` (wraps
a `ModelAdapter` and parses the JSON response) and a stub
for tests.

**Contamination guard:** `buildHypothesisPrompt` is the
ONLY way the optimizer sees input. The function takes only
the current ruleset (names + descriptions) and the recent
scoreboard entries. It does NOT take the benchmark; even
if a caller passes the benchmark, the prompt builder will
silently drop it.

`parseHypothesisFromLlm` — JSON parsing with tolerance for
surrounding prose; null on malformed input; null on empty
ruleChanges (no-op signal).

`BenchmarkRunner` interface — the seam where benchmark
evaluation lives. `DefaultBenchmarkRunner` builds
`AgentResult` stubs from each task's `stubKind` (empty, ok,
off-topic, forbidden-path) so cycles are fast and
deterministic.

`VerifierRule` gained an optional `description` field so
the hypothesis prompt can reason about the ruleset without
seeing the rule bodies. `hashRuleset`'s signature widened
to accept `description: string | undefined` (consistent
with `exactOptionalPropertyTypes`).

### Phase 3, Chunks 5c+5d — frozen benchmark + shadow cycle e2e (`8ed45fc`)
**§13.1, 5-step e2e.**

`test/fixtures/frozen-benchmark.yaml` — a reference benchmark
fixture (4 tasks covering the 4 stubKinds). Production uses
operator-curated benchmarks; this is the test/demo shape.

`test/self-evolve-e2e.test.ts` (4 tests) — full shadow cycle
e2e:
- Frozen benchmark fixture round-trips through `readBenchmark`.
- Complete shadow cycle: pre-populated live ruleset is NOT
  touched, kept entry is recorded, snapshot + candidate are
  written under `snapshots/`.
- The contamination guard holds end-to-end: a unique
  secret phrase in the benchmark NEVER appears in the
  hypothesis prompt. This is the safety net the design
  requires.
- Revert path: when the candidate is not strictly better,
  the entry is recorded as `reverted`.

### Phase 3, Chunk 5e — `envoy self-evolve` CLI subcommand (`02e9873`)
**§19, subcommand surface.**

`src/cli/argv.ts` refactor — `ParsedArgs` is now a
discriminated union (`RunParsedArgs | SelfEvolveParsedArgs`).
The first non-flag positional selects the subcommand
(`self-evolve` is the only one in v0; default is `run`).
Each subcommand has its own flag set; common flags
(`--help`, `--version`, `--no-color`, `--verbose`, `--quiet`)
are extracted into `handleCommonFlag`.

`src/cli/run.ts` — dispatch on subcommand. `run` is the
existing prompt → agent → result path. `self-evolve` wires
`ModelHypothesisProvider` + `DefaultBenchmarkRunner` +
`DEFAULT_RULES` into a `SelfEvolve` instance, runs one
cycle, prints a human-readable summary. Default paths
under `<cwd>/.envoymesh/`. Shadow mode is the default;
`--commit` enables real writes.

`CliRunResult` is now a discriminated union
(`RunResult | SelfEvolveRunResult`) with a `subcommand`
field for narrowing.

### F6.1 — Federated scoreboard: PeerSource + filter+verify (`7aa6085`)
**§13.3 of the design, F6.1 of the implementation plan.**

`src/scoreboard/federated.ts` — the federated layer (v0 of
this module; F6.2-F6.4 add the rest).

`PeerScoreboard` — a peer's published entries.
`PeerSource` — interface for fetching peer scoreboards.
The extension surface: new transports (libp2p, HTTPS
webhook, IPFS) implement it.
`LocalPeerSource` — v0 default: returns `[]`. No network in
v0; Phase 2 (mesh-native) replaces this with a libp2p
pubsub subscriber.
`FederatedScoreboard` — the pull layer. `optIn` defaults to
`false` (the safety net: pull is opt-in, never push). On
opt-in: fetch from `PeerSource`, drop entries whose status
isn't `kept`, verify each entry's signature
(`verifyEntrySignature`, SHA-256 over the canonical payload).
Returns `validatedCandidates` + `rejected` (with reason).
Transport errors are caught and turned into a no-op
result — a failed pull should not abort the local cycle.

Added `verifyEntrySignature` to `storage.ts` — recomputes
the canonical payload hash and compares to `ownerSignature`.
v0 protects against accidental corruption; Ed25519 with
the owner's key is Phase 2's real protection.

### F6.2 — Federated local 5-step gate (`362ae76`)
**§13.3, F6.2.**

`src/scoreboard/self-evolve.ts` — refactored `runOneCycle()`
to share a private `runOneCycleInner()` that takes an
optional `externalHypothesis`. New public method
`runOneCycleAgainst(hyp)` runs the 5-step protocol with a
fixed hypothesis, skipping the provider call. Two
semantic differences from the regular cycle:

1. **Never commits.** Even with `shadowMode=false`, a
   federated cycle does NOT replace the local ruleset.
   Adoption is a separate, opt-in step.
2. **Tags the hypothesis text with `[federated]`** so the
   audit trail shows the origin.

`src/scoreboard/federated.ts` — new `FederatedScoreboard.adopt()`
method. Takes a `pullResult` and a `SelfEvolve`, runs the
local 5-step gate against each validated candidate. Returns
the adopted set (those that passed the local gate, with the
local cycle's result attached) and the rejected set (those
that didn't, with reason).

The `ruleChanges` shipped by federated entries is empty in
v0 — the peer's hypothesis text is what the local gate
evaluates; the operator's local re-implementation is the
source of truth. Full rule bodies are a Phase 2 concern.

### F6.3 — Federated adoption records (`8076656`)
**§13.3, F6.3.**

`src/scoreboard/types.ts` — `FederatedAdoptionRecord` schema
and `FederatedAdoptions` (a list of records). Each record
links a peer's source entry (peerId, version, hypothesis,
rulesetHash, signature) with the local cycle that evaluated
it (localEntry version + pass rates) and the kept/rejected
verdict. `reason` is optional (rejected cases carry it).

`src/scoreboard/storage.ts` — `readAdoptions` /
`appendAdoption` (atomic temp+rename, same pattern as the
main scoreboard). Empty file returns empty list.

`src/scoreboard/federated.ts` — `adopt()` now accepts an
`adoptionsFile` option. Every evaluation (kept or rejected)
is appended to the file as an audit trail. The local cycle
counter still advances (the federated cycle is recorded in
the main scoreboard too — the `[federated]` prefix on the
hypothesis text marks it).

Without `adoptionsFile`, the `adopt()` result is still
returned but nothing is persisted (useful for tests and
one-shot evaluations).

### F6.4 — Federated `--pull` CLI flag (`fe0c5df`)
**§13.3, F6.4.**

`src/cli/argv.ts` — three new self-evolve flags:
- `--pull`: opt in to federated pull (default: off).
- `--peer-id <id>`: this peer's id (recorded in adoptions log).
- `--adoptions <path>`: federated adoptions YAML file
  (default: `<cwd>/.envoymesh/federated-adoptions.yaml`).

`src/cli/run.ts` — when `--pull` is set, after the local
cycle, build a `FederatedScoreboard` with `LocalPeerSource`,
run the pull + adopt (which records every evaluation to
the adoptions file), and report the result in the
human-readable summary. Without `--pull`, the federated
layer is a no-op (per design — pull is opt-in, never push).

The result includes a `federated` field with adopted /
rejected / filtered counts so callers can see what
happened.

### F7.1 — Cost tracking + `ModelResponse.usage` (`90a158f`)
**§14, F7.1.**

`src/cost.ts` (new) — the per-model USD cost story:
- `TokenPrice` (input/output per 1M tokens, USD).
- `DEFAULT_PRICING` table — OpenAI gpt-4o / 4o-mini / 4.1 /
  4.1-mini / 5, Anthropic sonnet-4-6 / haiku-4 / opus-4,
  DeepSeek chat / reasoner, plus `local` ($0).
- `computeCost(usage, model)` — pure math; rounds sub-cent
  to 6 decimal places.
- `CostTracker` — accumulates `addUsage(usage, modelOverride?)`,
  `total()` returns cost + per-model breakdown, `reset()` /
  `setModel(model)` for control. Per-call `modelOverride`
  enables multi-model attribution even when the tracker was
  constructed with a different default.

`src/model.ts` — added `usage?: { inputTokens, outputTokens }`
and `model?: string` to `ModelResponse`. The model id
attributes the response to a pricing row even when the
tracker was constructed with a different default model.

`src/agent.ts` — `AgentResult.metrics` is now populated
from a `CostTracker`. The agent loop calls
`tracker.addUsage(usage, model)` on every `ModelResponse`
that has `usage`.

`src/verifier/rules/index.ts` — wired the
`costReasonableForWorkRule`. Heuristic:
- `cost === 0` → `pass` (no model reported usage).
- `cost <= $1` (default budget) → `pass` with
  `score = cost / budget`.
- `cost > $1` → `fail` with `rollback: true` and
  reason "cost $X exceeds budget $Y".

Tests: 18 in `test/cost.test.ts` covering `computeCost`
math, `CostTracker` accumulation + per-model attribution,
and the rule's three branches.

### F7.2 — HTTP client abstraction + OpenAIAdapter
**§14, F7.2.**

`src/llm/http.ts` (new) — the seam where adapters make
HTTP calls:
- `HttpRequest` / `HttpResponse` / `HttpClient` interface.
- `FetchHttpClient` (production) — uses Node 22+ built-in
  `fetch`, no external deps.
- `FakeHttpClient` (tests) — records requests; FIFO queue
  with optional matcher predicates; `setDefault` fallback;
  throws when nothing queued and no default set.
- `zodToJsonSchema` — hand-rolled zod → JSON Schema
  converter. v0 covers `ZodString` / `ZodNumber` /
  `ZodBoolean` / `ZodOptional` / `ZodDefault` / `ZodNullable`
  / `ZodObject` / `ZodArray` / `ZodEnum`. Other zod types
  fall back to `{}` (additive extension point).
- `toolsToOpenAI` / `messagesToOpenAI` — wire format
  translation. Assistant text + tool calls are merged into
  one message; tool results emit one `role: "tool"` message
  per block; non-string tool result content is JSON-encoded.

`src/llm/openai.ts` (new) — `OpenAIAdapter implements
ModelAdapter`:
- POSTs to `${baseUrl}/chat/completions` (default
  `https://api.openai.com/v1`).
- Headers: `Content-Type: application/json`,
  `Authorization: Bearer ${apiKey}`, optional
  `OpenAI-Organization`.
- Body fields: `model`, `messages` (always),
  `tools` (when non-empty), `temperature` and
  `max_tokens` (when set).
- 2xx → parsed `parseChatResponse`; non-2xx → `parseError`
  thrown.
- `parseChatResponse` maps `finish_reason`:
  `stop`/`function_call` → `end_turn`,
  `tool_calls` → `tool_use`, `length` → `max_tokens`,
  `content_filter` → `stop_sequence`. Tool-call
  arguments are JSON-parsed; malformed JSON leaves
  `args = {}` (zod validation will surface the error).
- `parseError` formats `error.message` from the JSON
  body, falls back to a 200-char body slice for
  non-JSON.

**Self-review fixes** (caught while writing tests):
1. `zodToJsonSchema` enum was reading `def.value` —
   zod v3 stores values in `def.values` (array). Fixed.
2. `zodToJsonSchema` array was reading `def.innerType` —
   zod v3 stores the element in `def.type`. Fixed.
3. `OpenAIAdapter` constructor used a lazy `require()`
   factory that didn't satisfy `HttpClient` (the anonymous
   class had no `request` method). Dropped the laziness —
   `http.ts` is already imported for the converters — and
   now uses `new FetchHttpClient()` directly.

The array + enum bugs would have lurked until a tool used
`z.array(...)` or `z.enum(...)` (the built-in tools only
use `z.string()` + `z.optional()`, which happened to work
by accident). Self-review caught what "compile and pass"
would have shipped broken.

Tests: 58 in `test/llm-openai.test.ts` covering
`zodToJsonSchema` (10 shapes), `toolsToOpenAI` (3),
`messagesToOpenAI` (10 incl. mixed transcript),
`FakeHttpClient` (6 incl. FIFO, matcher, default, throw),
`FetchHttpClient` (1, smoke test against a mocked
`globalThis.fetch`), `OpenAIAdapter` request shape (8),
`OpenAIAdapter` error handling (3), `parseChatResponse`
(9 incl. text / tool-call / usage / no-choice / all four
stop-reason mappings / malformed tool args), `parseError`
(4 incl. JSON message, non-JSON body, no-error-field,
long-body truncation), and `is2xx` (2).

### F7.3 — `AnthropicAdapter` (`5acd49a`)
**§14, F7.3.**

`src/llm/anthropic.ts` (new) — `AnthropicAdapter
implements ModelAdapter`. Wire format differs from OpenAI
in 7 ways (full table in §6.2 F7.3 plan):
- Auth: `x-api-key` + `anthropic-version: 2023-06-01`
  headers (not `Authorization: Bearer`).
- System prompt is a top-level `system` field, not a
  message with `role: "system"`. `splitSystemAndMessages`
  extracts.
- Tool shape is flat `{ name, description, input_schema }`
  (no `function` wrapper, `input_schema` instead of
  `parameters`).
- Tool call in response is `content: [{ type: "tool_use",
  id, name, input }]` — mixed with text in one array.
- Tool results in the request are `role: "user"` with
  `content: [{ type: "tool_result", tool_use_id, content }]`.
- `max_tokens` is required by Anthropic. We default to
  `1024` (Anthropic's recommended default) when the caller
  doesn't pass one. Override via `CompleteInput.maxTokens`
  or `AnthropicAdapterOptions.defaultMaxTokens`.
- Usage field names `input_tokens` / `output_tokens` match
  our `ModelResponse.usage` directly (no rename needed).

**Hard requirements handled:**
- `max_tokens` always set in the body (default 1024).
- `anthropic-version` always set in headers (default
  2023-06-01).
- Empty assistant content → placeholder text block.
- Missing `usage` → no `usage` field on ModelResponse
  (cost is then 0 for that call).
- Empty response content → empty `content` array
  (the loop continues).

**Reuses** `zodToJsonSchema` and `FetchHttpClient` from
`http.ts` (F7.2). `toolsToAnthropic` and
`messagesToAnthropic` mirror their OpenAI counterparts
with the wire-format-specific translations.

Tests: 45 in `test/llm-anthropic.test.ts` covering
`splitSystemAndMessages` (5), `toolsToAnthropic` (3),
`messagesToAnthropic` (10 incl. full harness transcript),
`parseMessagesResponse` (9), `parseError` (4), `is2xx` (2),
`AnthropicAdapter` request shape (9), and
`AnthropicAdapter` error handling (3).

### F7.4 — `DeepSeekAdapter` (this commit)
**§14, F7.4.**

`src/llm/deepseek.ts` (new) — thin constructor wrapper
that subclasses `OpenAIAdapter`. DeepSeek's wire format
is identical to OpenAI's (POST `/chat/completions`, same
`messages` / `tools` / `usage` shapes, same
`choices[0].message` / `tool_calls` / `finish_reason`
response). The constructor just sets the DeepSeek
defaults:
- Base URL: `https://api.deepseek.com/v1` (vs OpenAI's
  `https://api.openai.com/v1`).
- Default model: `deepseek-chat`.
- API key env var: `DEEPSEEK_API_KEY` (handled by F7.5).

Other DeepSeek models (`deepseek-reasoner`, the reasoning
model) are selected by passing `model: "deepseek-reasoner"`
to the constructor. The adapter doesn't branch on the
model name — the wire format is the same.

**Why subclass, not delegate?** `OpenAIAdapter` is a
`ModelAdapter` implementation that handles the entire
OpenAI wire format end-to-end (request shape, response
parsing, error handling, stop-reason mapping,
malformed-args tolerance). Subclassing reuses all of it
without duplication. The constructor is a 4-line
defaults-setter.

Tests: 9 in `test/llm-deepseek.test.ts` covering defaults
(URL, model), overrides (custom model, custom baseUrl,
auth header), and end-to-end response parsing
(text-only, usage, tool-call stop reason, 4xx error).
The response-parsing tests serve as a regression guard
that subclassing doesn't break the OpenAI parser.

### F7.5 — CLI provider dispatch + `--max-cost-usd` (this commit)
**§14, F7.5.** Phase 2 milestone per design §22 ("real
LLM adapters + cost tracking") is now complete: 5 of 5
sub-chunks.

`src/llm/index.ts` (new) — provider dispatch + re-exports:
- `createProviderAdapter({ provider, model?, env? })`
  returns the right `ModelAdapter` for the given provider
  name. Supports `openai` / `anthropic` / `deepseek` /
  `ollama`. Reads API keys from `env` (default:
  `process.env`; override for tests).
- `DEFAULT_PROVIDER_MODELS` — per-provider default
  (gpt-4o / claude-sonnet-4-6 / deepseek-chat / llama3.1).
- `SUPPORTED_PROVIDERS` — the canonical provider list.
- `ollama` is keyless: uses the OpenAI-compatible
  endpoint at `http://localhost:11434/v1` (override via
  `OLLAMA_BASE_URL`). A placeholder API key (`"ollama"`)
  is passed because `OpenAIAdapter` requires a non-empty
  key.
- Case-insensitive provider name (`"openai"` / `"OpenAI"` /
  `"OPENAI"` all work).
- Throws on unknown provider with the list of supported
  names in the error message.

`src/agent.ts` — `AgentOptions.maxCostUsd`:
- New optional field. When set, the agent checks
  `costTracker.total().costUsd > maxCostUsd` after every
  model call that reports `usage`. If exceeded, the agent
  aborts cleanly with `stopReason: "aborted"` and the
  abort reason includes the cost + cap for debugging.
- The cap is checked DURING the run, not at the end —
  that's the whole point of a cap.

`src/cli/run.ts` — provider dispatch in `runAgent` and
`runSelfEvolve`:
- New `resolveModel()` helper: prefer `RunOptions.model`,
  fall back to `createProviderAdapter({ provider, model })`
  when `--provider` is set, throw `CliError(EXIT_USAGE)`
  otherwise. Both subcommands now accept `--provider`
  end-to-end.
- `createProviderAdapter` errors are wrapped as
  `CliError(EXIT_USAGE)` so the bin script's exit code
  is USAGE (not ERROR) for missing env / unknown provider.
- `--max-cost-usd` is passed to the agent when set.

`src/cli/argv.ts` — help text updated: provider list
reflects the actual supported names (openai / anthropic /
deepseek / ollama).

`src/index.ts` — re-exports the LLM module (adapters +
HTTP primitives + helpers + `createProviderAdapter` +
`DEFAULT_PROVIDER_MODELS` + `SUPPORTED_PROVIDERS`).

**Self-review caught:**
1. The cost cap tests initially failed because the
   scripted adapter's `ModelResponse` had no `model`
   field, so the `CostTracker` fell back to the
   constructor's default model (`"local"`, $0 pricing) —
   even with 1M input tokens, cost was 0. Fixed by
   setting `model: "gpt-4o"` in the test's response
   builder. **This is a real-world gotcha**: adapters
   that don't set `response.model` will be silently
   priced as local. The cost attribution comment in
   `agent.ts` already noted this risk ("Unknown model +
   missing usage = 0 cost") — the tests now exercise
   the right path.
2. The "cap DURING the run" test was wrong: a pure-text
   response ends the loop, so the second call never
   happened. Fixed by giving the first response a
   tool call (forcing the loop to continue) and the
   second response a text result (testing the cap
   triggers after the second iteration, not the first).
3. The `--provider openai` dispatch test timed out
   because the test machine might have `OPENAI_API_KEY`
   set (real network call). Fixed by saving and
   unsetting the env var in a `try/finally` block.

Tests: 28 in `test/cli-provider-dispatch.test.ts` covering
`createProviderAdapter` per-provider (15), `runAgent`
dispatch (4), `Agent.maxCostUsd` cap (6), CLI integration
(2), and public API surface (1).

**End-to-end smoke verified:** `env -u OPENAI_API_KEY
pnpm run envoy --provider openai 'hi'` exits 64 with
message `"--provider requires OPENAI_API_KEY env var to
be set"`. The bin script is now usable for real providers
once the corresponding `*_API_KEY` is set.

### F8 — `envoy-harness-adapter` (Package 3 — MAP integration) — Phase 2 complete
**§11, design.en.md (the reference MAP adapter).** F8.0
through F8.7 are committed. **Phase 2 milestone per
design §22 is now "F8 done" — Phase 2 fully complete.**

**F8.0 — Monorepo restructure + scaffold.** The repo
is now a pnpm workspace with two packages:
`packages/envoy-harness/` (Package 1) and
`packages/envoy-harness-adapter/` (Package 3). New
workspace root files: `pnpm-workspace.yaml`,
`tsconfig.base.json`, root `package.json` (private),
workspace-level `README.md`. CI is now `pnpm -r run
typecheck/test/build`. Per-package tsconfig extends
`tsconfig.base.json`. `.gitignore` defensively excludes
tsc outputs to `bin/`. The new package depends on
`@envoymesh/envoy-harness` (workspace:*),
`@envoymesh/agent-adapter`, `@envoymesh/protocol`,
`@envoymesh/identity` (link: paths to the EnvoyMesh
sibling monorepo). 488 + 2 = 490 tests passing.

**F8.1 — `ENVOY_HARNESS_SKILLS` catalog** (5 skills):
`code-edit`, `code-review`, `doc-search`, `bash-run`,
`plan`. Cost ceilings from design §11: $5/$3/$1/$0.50/$1.
All v0 skills are `maxSensitivity: "private"`. Skill →
local tool set mapping in `getToolsForSkill()`:
read-only skills expose only `read_file`; `code-edit`
exposes both `read_file` + `bash`; `bash-run` exposes
only `bash`. `isReadOnlySkill()` for permission-mode
decisions. 19 new tests.

**F8.2 + F8.4 + F8.5 + F8.6 — `EnvoyHarnessAdapter`
class.** Implements `AgentAdapter` from
`@envoymesh/agent-adapter`. Dependency-injection pattern
(per `OpenClawAdapter`): `buildAgent` factory + `signResult`
closure + `workerPeerId` + optional `runtimeVersion` +
optional `buildPrompt`. The adapter is **runtime-agnostic**
— no app-level imports. Methods:
- `describeSkills()` — returns the 5-skill catalog.
- `buildManifest(input)` — returns an unsigned
  `CapabilityManifest`. The orchestrator signs with
  the owner's key.
- `execute(input)` — builds a local `Agent` via the
  factory, runs the skill, translates via
  `localToWireResult`, signs. Respects `input.signal`
  (cancellation) and `input.costCeilingUsd` (passes as
  `Agent.maxCostUsd` so the harness aborts when
  exceeded). The wire `content` is just the final
  assistant text (matches `OpenClawAdapter`); the
  full transcript (including tool calls + tool results)
  is preserved in `AgentResult.raw` for audit; the
  signature covers `raw` so a malicious adapter cannot
  retroactively edit it.
- `verify(input)` — first-cut deterministic
  (non-empty + non-echo). v0 placeholder; future chunk
  wires the local verifier rules.
- `defaultBuildAgentFactory({ model, cwd? })` —
  exported helper for callers that don't want to write
  their own factory. Builds a fresh `Agent` per
  `execute()` with the skill's tool subset from
  `BUILTIN_TOOLS`.

**F8.3 — Local ↔ wire translation.** Lossy in one
direction (local → wire). Stable schemaRefs for tool
calls and tool results (`envoymesh://tool-call/v1`,
`envoymesh://tool-result/v1`) — these are an internal
contract between envoy-harness adapters on different
nodes. The full local `AgentResult` is preserved in
`AgentResult.raw` (typed `unknown`). 17 new tests.

**Tests:** 14 in `test/adapter.test.ts` (describeSkills,
buildManifest, execute text-only, execute tool-call,
execute cancellation, verify 3 cases,
defaultBuildAgentFactory). Total: 52 tests in the
adapter package; 488 in the harness package; **540
total across the monorepo**.

**Known limitations (followups):**
1. `signResult` is not wired to a real Ed25519 signer in
   v0; tests use a fake that stamps a SHA-256 hash. A
   future chunk integrates with `@envoymesh/identity`'s
   `signCanonicalPayload`.
2. The adapter depends on the EnvoyMesh monorepo via
   `link:` paths. Cross-repo changes require updating
   both. A future chunk could move the adapter into the
   EnvoyMesh monorepo if a cleaner separation is wanted.
3. `verify()` is the first-cut placeholder. The
   local verifier rules (F1.4d) should be wired in
   F8.6+ (a follow-up chunk).

### F9.1 — Per-call approval callback (Penguin style)
**Phase 4 first sub-chunk.** Per-call approval is the
smallest, most user-facing Phase 4 feature.

**The flow:**
1. Tool call comes in (e.g. `bash("rm -rf /")`).
2. `firePreToolUse` returns `HookDecision` with a new
   `kind: "ask"` variant.
3. The agent loop sees the `ask` decision and pauses.
4. The loop calls `AgentOptions.askHandler({ tool,
   args, question, options, signal })` and awaits
   the host's response.
5. The host returns `AskDecision`:
   - `allow` → tool runs as-is.
   - `deny` → tool result is `"denied by user: <reason>"`
     with `isError: true`.
   - `modify` → tool runs with the modified args
     (re-validated against the tool's zod schema).
6. The agent resumes; the transcript records the ask
   + decision for audit.

**Type changes (additive):**
- `HookDecision` gains a `{ kind: "ask", question,
  options? }` variant.
- New `AskDecision` union (`allow | deny | modify`).
- New `AskRequest` interface.
- New `AskHandler` type.

**Agent integration:** `AgentOptions.askHandler?: AskHandler`.
`executeToolCall` handles `ask`: calls the handler, on
`deny` appends a "denied by user: <reason>" tool
result, on `modify` replaces the call args and
re-validates against the tool's zod schema, on
`allow` falls through to the tool runner. No handler
configured → defaults to `deny` (safe default — the
tool is blocked with "no ask handler configured").

**Hook registry fix:** the `fire()` function's
decision handling only knew about `block` / `modify` /
`add-context`. The new `ask` decision silently fell
through to `continue` (the fire-time default). Tests
caught this — the handler was never called because
the registry kept returning `continue`. Fixed by
adding explicit `ask` handling: the last `ask` wins
(if no `block` came first); `ask` is only valid for
`PreToolUse` events.

**CLI integration (B.4):**
- `RunOptions.askHandler?: AskHandler` — forward to agent.
- `defaultAskHandler`: built-in fallback that writes a
  one-line "ask" record to stderr and returns `deny`.
  Safe in headless contexts (no UI). Production hosts
  (Tauri, web) inject a real UI handler via `RunOptions`.
- Re-exported from the package's public API.

**Tests: 10 new in `test/per-call-approval.test.ts`.**
- Handler called when hook returns `ask`.
- `allow` / `deny` / `modify` paths.
- No handler → defaults to deny.
- `AskRequest` carries tool, args, question, options, signal.
- Transcript shows "denied by user: <reason>" on deny.
- Modified args that fail zod → "invalid arguments".
- Backward compat: `continue` / `block` unchanged.

**Self-review fix caught by tests:** the registry's
`fire()` didn't know about the new `ask` decision.
The handler was never called because the registry
kept returning `continue`. **This is exactly the
kind of bug a hand-written handler / registry has
when a new decision variant lands** — the
type-checker doesn't catch it (the existing code
just doesn't match), and a unit test of the new
feature doesn't see it. **The full-pipeline test
(agent → registry → handler) caught it.** This is
why the integration tests matter.

**Total: 564 tests across 28 files (498 harness +
66 adapter).** The F8 known limitations are now
all resolved (signResult is real Ed25519; verify()
is the local verifier; only the link: dep on
EnvoyMesh remains as a v0 cross-repo limitation).

**Next: F9.2 (LSP) or F9.4 (--json trace mode).**
The user picks.

---

## 3.5 Phase 6 — REPL (in progress)

### F17.1 — REPL loop scaffold (✅ done)

The first sub-chunk of F17 (interactive REPL). The
REPL reads lines, dispatches them to a long-lived
`Agent`, and prints the result. A single `Agent` is
reused across turns so the session, hooks, AGENTS.md,
and permission state are preserved.

**What it ships:**
- `--repl` flag in argv parser (boolean, no value).
- `envoy --repl` activates the REPL; no positional
  prompt required. `envoy --repl foo` is a
  `CliError(EXIT_USAGE)` ("--repl takes no positional
  prompt; type into the REPL instead").
- `runRepl(opts: ReplOptions): Promise<ReplResult>`
  in `src/cli/repl/loop.ts` — the REPL loop.
- `LineReader` interface (async-iterable over
  lines) with a default readline-on-stdin
  implementation. Tests inject a `fakeLineReader`
  that yields predetermined lines for determinism.
- Single `Agent` constructed once inside `runRepl`
  and reused across turns (the `session` is shared
  → transcript accumulates, hooks fire once, the
  parent's `--json` tracer streams events to stdout
  for every turn).
- Built-in exit: `/quit`, `/exit`, or EOF (Ctrl-D).
- Empty lines ignored (don't reach the model).
- Unknown `/command` lines print to stderr as a
  placeholder (F17.2 will replace with the real
  registry).
- Agent errors print to stderr but don't kill the
  REPL — the next turn can still run.
- `ReplResult { exitCode, turns, totalCostUsd, sessionId }`
  for the caller to summarize.
- Re-exported from `@envoymesh/envoy-harness`:
  `runRepl`, `ReplOptions`, `ReplResult`, `LineReader`.

**Files touched (3 new + 3 edited):**
- `src/cli/repl/types.ts` (new) — `ReplOptions`,
  `ReplResult`, `LineReader`.
- `src/cli/repl/loop.ts` (new) — `runRepl` +
  the readline-based `LineReader` implementation.
- `src/cli/repl/index.ts` (new) — re-exports.
- `src/cli/argv.ts` (edit) — `--repl` flag + parser
  case + help text.
- `src/cli/run.ts` (edit) — `if (args.repl) { ... }`
  dispatch in the runner.
- `src/cli/index.ts` (edit) + `src/index.ts` (edit)
  — re-exports.
- `test/repl-loop.test.ts` (new) — 13 tests.

**Self-review caught 2 real bugs in the test file:**
(1) unused `CliError` + `ContentBlock` imports
(caught by `strict: true` `noUnusedLocals`), and
(2) the `fakeLineReader.next()` returned
`{ value: lines[i++], done: false }` with `lines[i]`
typed as `string | undefined` (the index access
fell under `noUncheckedIndexedAccess`) — fixed by
extracting the value to a local and re-checking
undefined. Both fixed before commit; one rebuild
verified clean.

**The production `LineReader` is unverified by tests.**
Tests use a fake; the readline-based implementation
in `createReadlineLineReader` is small (~40 LoC) and
follows the canonical event-based iterator pattern.
A manual smoke test (`envoy --repl`, type a prompt,
see the response, type `/quit`) covers the gap.
The next chunk (F17.2) will add the slash command
registry; if smoke breaks, the bug surfaces there.

**Total: 804 tests across 53 files** (envoy-harness
712 + envoy-harness-adapter 92). F17.1 is done.
F17.2 (slash command registry) is the next sub-chunk.

Updated §1 (status line + Phase 6 row in summary),
§2 (status table Phase 6 row + per-module test
inventory + REPL test row), §3 (this entry),
§6.7 (F17.1 marked ✅), §10 (this entry).

**Next: F17.2** (slash command registry: `/help`,
`/model`, `/provider`, `/sandbox`, `/approval`,
`/clear`, `/cost`, `/status`, `/quit`).

### F17.2 — Slash command registry (✅ done)

9 built-in slash commands. Open to host extension via
`ReplOptions.customCommands`. Built-ins always win on
name collision (custom registers first; built-ins
register last, overriding).

**What it ships:**
- `ReplCommand` type (`{ name, description, hidden?,
  handler }`) — the public shape of a slash command.
- `ReplCommandRegistry` class (`register`,
  `registerAll`, `lookup`, `listVisible`, `size`).
- `parseCommandLine(line)` — tokenizer; returns `null`
  for non-slash lines, `{ name: "", args: [] }` for
  a lone `/`.
- `dispatchCommand(registry, name, args, ctx)` —
  returns `{ kind: "ok" | "exit" | "unknown" | "error" }`.
  `/quit` and `/exit` are intercepted at the dispatcher
  level (return `exit`); unknown names return
  `unknown` (the REPL prints the message + `/help`
  hint); handler throws → `error` (the REPL prints
  `error: <message>` to stderr but the loop continues).
- 9 built-ins: `/help`, `/model`, `/provider`,
  `/sandbox`, `/approval`, `/clear`, `/cost`,
  `/status`, `/quit`. Each is ~10-30 LoC.
- `Agent.setModel`, `setAskHandler`, `setPermissionMode`
  — additive public setters so commands can mutate the
  running agent (model swap, sandbox change).
- `Agent.clearSession()` — wraps `session.clear()`.
- `Agent.getCost()` — wraps `costTracker.total()`.
- `ReplContext.registry` — the live registry; the
  `/help` command reads it to enumerate visible
  commands. Set by `runRepl` before dispatching.

**`/model` v0 limitation:** `/model <id>` doesn't
build an adapter from the id alone (the host injects
real adapters via `ReplOptions.model`). It prints a
hint. `/provider <name>` works for the 4 supported
providers when the matching env var is set (the
adapter is built via `createProviderAdapter`).

**`/approval` v0 limitation:** for non-`never` modes,
the installed handler always-allowes. A real
per-REPL host handler (Tauri app, in-process ask
queue) is a F17.5+ candidate.

**Files touched (5 new + 2 edited):**
- `src/cli/repl/registry.ts` (new) — `ReplCommandRegistry`,
  `parseCommandLine`, `dispatchCommand`.
- `src/cli/repl/commands.ts` (new) — `BUILTIN_COMMANDS`
  + 9 command handlers.
- `src/cli/repl/types.ts` (edit) — `ReplCommand`,
  `ReplContext.registry`, `ReplOptions.customCommands?`.
- `src/cli/repl/loop.ts` (edit) — replace the
  `EXIT_COMMANDS` set + the unknown-slash placeholder
  with the registry-based dispatch.
- `src/cli/repl/index.ts` (edit) + `src/cli/index.ts`
  (edit) + `src/index.ts` (edit) — re-exports.
- `src/agent.ts` (edit) — 3 setters + 2 helpers
  (all additive).
- `test/repl-commands.test.ts` (new) — 25 tests.

**Self-review caught 1 real bug + cleaned 2 smells:**
1. The first test run failed: the `BUILTIN_COMMANDS`
   array was registered BEFORE `customCommands`, but
   `register()` is last-write-wins, so custom `/help`
   shadowed the built-in. **Fixed:** register
   `customCommands` first, then `BUILTIN_COMMANDS` last
   (so built-ins override). Matches the plan's
   "built-ins always win on name collision" contract.
2. The `/help` and `/cost` and `/clear` commands used
   `as unknown as { ... }` casts to access private
   agent fields (`__registry`, `costTracker`, `session`).
   **Cleaned:** added `Agent.clearSession()`,
   `Agent.getCost()`, and `ReplContext.registry`. No
   more casts; the public types match the actual access
   surface.
3. The `getCost()` initial signature used a `calls`
   field that `RunCost` doesn't have. **Fixed:** dropped
   `calls` from the getter; `/cost` no longer prints it
   (a follow-up chunk can extend `RunCost` if needed).

**Total: 829 tests across 54 files** (envoy-harness
737 + envoy-harness-adapter 92). F17.2 is done.
F17.3 (history persistence) is the next sub-chunk.

Updated §1 (status line), §2 (status table Phase 6
row + per-module test inventory + REPL commands row),
§3 (this entry), §6.7 (F17.2 marked ✅), §11 (F17
archive updated).

**Next: F17.3** (history persistence:
`~/.local/state/envoy-harness/history`).

---

## 4. Architectural invariants (what we hold)

From design §4 and our own additions during implementation:

1. **Zero EnvoyMesh-internal deps** in Package 1. The
   adapter (Package 3) is the bridge. The `agent-adapter`
   test in `packages/protocol/test/agent-adapter-integration.test.ts`
   (in the EnvoyMesh repo) verifies coexistence; we don't
   need to repeat it here.
2. **Capability seams complete.** bash validation, hooks,
   tools, model, session, verifier each have Service
   Definition / Provider / Consumer roles. Per glossary.
3. **Local types mirror wire types.** `Verdict`,
   `VerifierSource`, `SkillId`, `AgentRuntime` are defined
   locally and match the wire values verbatim.
4. **`exactOptionalPropertyTypes: true`** respected throughout.
   Conditional spreads (`...(x !== undefined ? { x } : {})`)
   are the pattern for optional fields.
5. **Tree-shakable runners.** `runShellHandler` /
   `runModuleHandler` are dynamic-imported only when a
   declarative `HookHandler` is registered.
6. **Test isolation.** every test gets a fresh
   `HookRegistry` / `ToolRegistry` / `Session` / `SelfEvolve`.
   `FakeModel` snapshots its input so test assertions don't
   see later mutations.
7. **Contamination guard (§13).** `buildHypothesisPrompt`
   is the only path to the optimizer. The test asserts the
   prompt does NOT contain `benchmark`, `gold`, `rubric`,
   `frozen`, and embeds a unique secret phrase in the
   benchmark to verify end-to-end.
8. **Shadow mode default.** Self-evolution never commits
   unless `--commit` is passed. The operator inspects the
   scoreboard history first.

---

## 5. In-flight risks & known issues

### 5.1 `policyFromMode` duplication
**Where:** `src/tools/builtin/bash.ts:46` (`policyFromMode`)
and `src/agent.ts` (`policyFromSessionMode`) independently
derive `SandboxPolicy` from the session's `permissionMode`.
They MUST stay in sync. If you change one, change the other.
**Fix:** extract a single helper in a follow-up. Tracked as
risk #1 in `.github/PHASE-1-3-REVIEW.md`.

### 5.2 `defaultRegistry` is module-level state
**Where:** `src/hooks/registry.ts` — exposed as a singleton
for the orchestrator's convenience. Tests don't touch it
(they use `new HookRegistry()` per test), so no pollution
risk in v0. The convention is documented in the
`defaultRegistry` JSDoc.

### 5.3 `Agent.abort()` does not cancel in-flight model calls
**Where:** `src/agent.ts` — `agent.abort()` sets the flag
but doesn't interrupt a `model.complete()` already running.
The current iteration finishes, then the loop checks the
flag and exits. Streaming cancellation is a v0+ concern.

### 5.4 Sign entry is SHA-256, not Ed25519
**Where:** `src/scoreboard/storage.ts:signEntry` — v0 signs
with SHA-256 of the canonical JSON payload. Real Ed25519
signing needs the owner key, which is a separate concern.
Until then, the scoreboard is tamper-resistant only against
accidental edits, not against a malicious process.

### 5.5 `hashRuleset` is name + description only
**Where:** `src/scoreboard/storage.ts:hashRuleset` — the
canonical sort is `(name, description)`. Adding a new rule
to the ruleset changes the hash. Phase 2 (mesh-native) will
need a version-aware hash; v0 is fine because rules are
code (not data) and changes are explicit.

### 5.6 `FakeModel` test fixture
**Where:** `test/fixtures/fake-model.ts` — not in the public
API. Real model adapters (Phase 2) belong in a separate
`llm` package.

### 5.7 Real LLM adapters — done
**Where:** `src/llm/` — `OpenAIAdapter` (F7.2),
`AnthropicAdapter` (F7.3), `DeepSeekAdapter` (F7.4), and
`createProviderAdapter` (F7.5) are wired and tested
end-to-end. The bin script dispatches via `--provider` +
env vars (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`DEEPSEEK_API_KEY`; ollama is keyless). The cost cap
(`--max-cost-usd`) is enforced in the agent loop after
every model call, not at the end. End-to-end smoke
verified: `env -u OPENAI_API_KEY pnpm run envoy
--provider openai 'hi'` exits 64 with message
"`--provider requires OPENAI_API_KEY env var to be set`".

### 5.8 `parseArgs` returns a discriminated union
**Where:** `src/cli/argv.ts` — every caller must narrow on
`subcommand`. Tests use a `parseRun()` helper. The next time
we add a subcommand, the pattern repeats.

### 5.9 Federated pull is a no-op without a real `PeerSource`
**Where:** `src/scoreboard/federated.ts:LocalPeerSource` —
returns `[]`. The federated layer is wired end-to-end
(PeerSource, filter+verify, local gate, audit trail, CLI
flag) but there's no actual mesh. Phase 2 (mesh-native)
replaces `LocalPeerSource` with a libp2p pubsub subscriber
that collects peer scoreboards. Until then, `envoy
self-evolve --pull` is a no-op.

### 5.10 Federated cycle never commits even when kept
**Where:** `src/scoreboard/self-evolve.ts:runOneCycleInner`
— a federated cycle (with `externalHypothesis`) does NOT
write to the live ruleset regardless of `shadowMode`. The
local 5-step protocol's `kept` verdict is the gate, but
"adoption" in v0 means "we recorded this in the audit
trail" — not "we applied the change". Adoption that
actually writes to the ruleset is a Phase 2 concern (the
operator's local re-implementation, plus Ed25519
verification of the peer's full ruleset).

### 5.11 `--max-cost-usd` is a silent no-op when adapter omits `response.model`
**Where:** `src/agent.ts:cost attribution` — the agent
calls `costTracker.addUsage(usage, response.model)`. If
`response.model` is `undefined` (e.g. a custom adapter
that forgets to set it), the tracker falls back to its
constructor model (`"local"`, $0 pricing). The cost is
silently 0; the cap never fires.
**All three shipped adapters (OpenAI, Anthropic, DeepSeek)
set `response.model` from the server's response** — the
silent no-op is unreachable through the public API. The
risk is for custom `ModelAdapter` implementations.
**Mitigation:** the F7.1 contract documents this; the
agent's `cost attribution` comment also notes it. A
future chunk could add a `console.warn` when usage is
present without a model name.

---

## 6. Planned work (the next 2 follow-ups, in order)

F6 (federated scoreboard) is **DONE** (F6.1-F6.4 all committed
on 2026-08-18). See §3 for the done-work entries. F6 moved
Phase 3 to "4 of 4 done" — the §22 milestone is complete.

The remaining follow-ups are the two Phase 2 workstreams
that the user prioritized.

### 6.1 ~~F6 — Federated scoreboard (§13.3)~~ DONE
~~**Status:** in progress (started 2026-08-18).~~ **DONE**
(F6.1-F6.4 all committed; see §3 for the done-work entries).
Phase 3 milestone per design §22 is now "4 of 4 done".

### 6.2 F7 — Pre-Phase-2 prerequisite: real LLM adapters + cost tracking (§14)
**Status:** done (5 of 5 sub-chunks: F7.1 + F7.2 + F7.3 +
F7.4 + F7.5). F7 is technically a prerequisite to Phase 2
proper (the MAP integration in F8) — the harness needs
real LLM adapters to be a useful mesh participant. Per
the original implementation-plan, F7 was tagged "Phase 2"
loosely; the design §22's strict Phase 2 is F8
(`envoy-harness-adapter`).

**Scope:**
- `src/llm/openai.ts` — OpenAI adapter (`ModelAdapter`).
- `src/llm/anthropic.ts` — Anthropic adapter.
- `src/llm/deepseek.ts` — DeepSeek adapter.
- Provider dispatch in the bin script: `--provider openai
  | anthropic | deepseek` resolves to the right adapter.
- `src/cost.ts` — token counting + USD cost tracking.
  Hook into `PostToolUse` to attribute cost to the call.
  Wire into `AgentResult.metrics.costUsd`.
- Update `costReasonableForWorkRule` to use the new metrics
  (was returning null in v0).

**Tests:** each adapter has a `FakeHttpClient` mock that
asserts request shape; cost tests cover token-to-USD for
each model.

**Sub-chunks (in order):**

| ID | Scope | Files | Status |
|----|-------|-------|--------|
| **F7.1** | `src/cost.ts` with `TokenPrice`/`CostTracker`/`DEFAULT_PRICING`; `ModelResponse.usage`; `AgentResult.metrics`; `costReasonableForWorkRule` wired. | `src/cost.ts`, `src/model.ts`, `src/agent.ts`, `src/verifier/rules/index.ts`, `test/cost.test.ts` | ✅ done (`90a158f`) |
| **F7.2** | `HttpClient` abstraction (`FetchHttpClient` + `FakeHttpClient`); `OpenAIAdapter` translating to OpenAI's chat/completions wire format. | `src/llm/http.ts`, `src/llm/openai.ts`, `test/llm-openai.test.ts` | ✅ done (this commit) |
| **F7.3** | `AnthropicAdapter` — different wire format (POST `/v1/messages`, system role separate). | `src/llm/anthropic.ts`, `test/llm-anthropic.test.ts` | ✅ done (`5acd49a`) |
| **F7.4** | `DeepSeekAdapter` — OpenAI-compatible, different base URL + key env. | `src/llm/deepseek.ts`, `test/llm-deepseek.test.ts` | ✅ done (this commit) |
| **F7.5** | `bin/envoy-harness.ts` reads `--provider` and env vars; dispatches to the right adapter. `--max-cost-usd` enforces a cap. | `src/llm/index.ts`, `src/agent.ts`, `src/cli/run.ts`, `test/cli-provider-dispatch.test.ts` | ✅ done (this commit) |

**Type changes (F7.1):**

```ts
// src/model.ts — add to ModelResponse
interface ModelResponse {
  content: ContentBlock[];
  stopReason: ...;
  // NEW: usage in tokens (OpenAI/Anthropic/DeepSeek all report this).
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

// src/agent.ts — add to AgentResult
interface AgentResult {
  // ... existing fields ...
  // NEW: accumulated metrics across the run.
  metrics: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}
```

**Cost tracking module (F7.1):**

```ts
// src/cost.ts
export interface TokenPrice {
  /** USD per million input tokens. */
  inputUsdPerMTok: number;
  /** USD per million output tokens. */
  outputUsdPerMTok: number;
}

export const DEFAULT_PRICING: Record<string, TokenPrice> = {
  // OpenAI (as of 2026)
  "gpt-4o":         { inputUsdPerMTok: 2.5,  outputUsdPerMTok: 10.0 },
  "gpt-4o-mini":    { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6 },
  // Anthropic
  "claude-sonnet-4-6": { inputUsdPerMTok: 3.0, outputUsdPerMTok: 15.0 },
  "claude-haiku-4":    { inputUsdPerMTok: 1.0, outputUsdPerMTok: 5.0 },
  // DeepSeek
  "deepseek-chat":     { inputUsdPerMTok: 0.14, outputUsdPerMTok: 0.28 },
};

export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricing: Record<string, TokenPrice> = DEFAULT_PRICING,
): number { ... }

export class CostTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  addUsage(usage: { inputTokens: number; outputTokens: number }): void { ... }
  total(): { inputTokens: number; outputTokens: number; costUsd: number } { ... }
}
```

**HTTP client abstraction (F7.2):**

```ts
// src/llm/http.ts
export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export class FetchHttpClient implements HttpClient {
  // Uses global fetch (Node 22+ / undici).
  async request(req: HttpRequest): Promise<HttpResponse> { ... }
}
```

In tests, we use a `FakeHttpClient` that records requests
and returns canned responses — no real network.

**OpenAIAdapter (F7.2):**

```ts
// src/llm/openai.ts
export class OpenAIAdapter implements ModelAdapter {
  async complete(input: CompleteInput): Promise<ModelResponse> {
    const body = {
      model: this.model,
      messages: messagesToOpenAI(input.messages),  // local → OpenAI
      ...(input.tools.length > 0 ? { tools: toolsToOpenAI(input.tools) } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
    };
    const resp = await this.http.request({
      method: "POST",
      url: `${this.baseUrl}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    return parseChatResponse(JSON.parse(resp.body));
  }
}
```

**AnthropicAdapter (F7.3):** meaningfully different wire
format. Key differences from OpenAI:

| Aspect | OpenAI | Anthropic |
|---|---|---|
| Endpoint | `POST /v1/chat/completions` | `POST /v1/messages` |
| Auth | `Authorization: Bearer <key>` | `x-api-key: <key>` + `anthropic-version: 2023-06-01` |
| System prompt | in messages, `role: "system"` | top-level `system` field |
| Message roles | `system / user / assistant / tool` | `user / assistant` only; tool results are `role: "user"` with `[{ type: "tool_result" }]` |
| Role alternation | any | strict (user ↔ assistant) |
| Tool shape | `{ type: "function", function: { name, description, parameters } }` | `{ name, description, input_schema }` (flat, no `function` wrapper) |
| Tool call in response | `message.tool_calls: [...]` | `content: [{ type: "tool_use", id, name, input }]` (mixed with text in one array) |
| Stop reason | `stop / tool_calls / length / content_filter / function_call` | `end_turn / max_tokens / stop_sequence / tool_use` (mostly 1:1) |
| Usage field names | `prompt_tokens / completion_tokens` | `input_tokens / output_tokens` (matches our `ModelResponse.usage`) |

```ts
// src/llm/anthropic.ts (planned)
export class AnthropicAdapter implements ModelAdapter {
  async complete(input: CompleteInput): Promise<ModelResponse> {
    const { system, messages } = splitSystemAndMessages(input.messages);
    const body = {
      model: this.model,
      max_tokens: input.maxTokens ?? 1024,  // Anthropic REQUIRES max_tokens
      ...(system ? { system } : {}),
      messages: messagesToAnthropic(messages),
      ...(input.tools.length > 0 ? { tools: toolsToAnthropic(input.tools) } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    };
    const resp = await this.http.request({
      method: "POST",
      url: `${this.baseUrl}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
    return parseMessagesResponse(JSON.parse(resp.body));
  }
}
```

**Helpers (exported for tests):**
- `splitSystemAndMessages(messages)` — pulls the first
  `role: "system"` block(s) out, concatenates their text,
  returns `{ system, messages }`. If there are no system
  messages, `system` is `""` (we only emit the `system`
  field when non-empty).
- `messagesToAnthropic(messages)` — converts our
  `Message[]` to Anthropic's wire format. Tool results
  become `role: "user"` with `content: [{ type:
  "tool_result", tool_use_id, content }]`. Empty content
  arrays are guarded against.
- `toolsToAnthropic(tools)` — flat `{ name, description,
  input_schema }`, no `function` wrapper. Reuses
  `zodToJsonSchema` from `http.ts`.
- `parseMessagesResponse(parsed)` — iterates the response
  `content` array, emits `text` and `tool_use` blocks
  directly. Tool-use args come in as `input` (already an
  object, not a JSON string). `stop_reason` is
  pass-through except `tool_use` → `tool_use` (already
  matches our internal enum). `usage` maps
  `input_tokens` / `output_tokens` directly.
- `parseError` — formats `error.message` from the JSON
  body, falls back to a 200-char body slice for non-JSON.

**Hard requirements:**
- `max_tokens` is **required** by Anthropic. If the
  caller doesn't pass one, default to `1024` (Anthropic's
  recommended default; the harness's caller can override).
- `anthropic-version` is **required** by Anthropic. Use
  `2023-06-01` (the current stable version).
- Empty `content` arrays are invalid. If an assistant
  message has no text and no tool calls, emit a single
  placeholder text block.

**Tests:** ~40 in `test/llm-anthropic.test.ts` covering
request shape (URL, headers, body w/ and w/o system
prompt, role alternation, tool format, max_tokens
defaulting), response parsing (text only, tool-use only,
mixed text+tool-use, usage mapping, all four stop
reasons, no-content, no-usage), error handling (4xx
JSON, 5xx JSON, non-JSON body, missing-max_tokens
guard), and the split/format helpers (system
extraction, tool result as user message, empty-content
guard).

**Provider dispatch + cost cap (F7.5):**

The bin script needs to translate `--provider <name>` to
the right adapter. The translation lives in a new helper
in `src/llm/index.ts`:

```ts
// src/llm/index.ts
export interface ProviderConfig {
  /** "openai" | "anthropic" | "deepseek" | "ollama" */
  provider: string;
  /** Optional model override (provider has a default). */
  model?: string;
  /** Optional env override (for tests). Default: process.env. */
  env?: NodeJS.ProcessEnv;
}

export function createProviderAdapter(config: ProviderConfig): ModelAdapter {
  const env = config.env ?? process.env;
  const provider = config.provider.toLowerCase();
  switch (provider) {
    case "openai": {
      const apiKey = requireEnv(env, "OPENAI_API_KEY");
      return new OpenAIAdapter({
        apiKey,
        model: config.model ?? "gpt-4o",
      });
    }
    case "anthropic": {
      const apiKey = requireEnv(env, "ANTHROPIC_API_KEY");
      return new AnthropicAdapter({
        apiKey,
        model: config.model ?? "claude-sonnet-4-6",
      });
    }
    case "deepseek": {
      const apiKey = requireEnv(env, "DEEPSEEK_API_KEY");
      return new DeepSeekAdapter({
        apiKey,
        model: config.model ?? "deepseek-chat",
      });
    }
    case "ollama": {
      // Ollama exposes an OpenAI-compatible endpoint at
      // /v1 (no auth). We point the OpenAIAdapter at it.
      return new OpenAIAdapter({
        apiKey: "ollama",  // OpenAIAdapter requires a non-empty key
        model: config.model ?? "llama3.1",
        baseUrl: env["OLLAMA_BASE_URL"] ?? "http://localhost:11434/v1",
      });
    }
    default:
      throw new Error(`unknown provider: ${config.provider}`);
  }
}
```

**Cost cap (`--max-cost-usd`):** the cap is enforced
*inside* the agent loop, not at the end of the run.
After every model call that reports `usage`, the agent
checks `costTracker.total().costUsd > maxCostUsd` and
aborts if so. The result has `stopReason: "aborted"` and
the user sees the cap message in the transcript.

```ts
// src/agent.ts — add to AgentOptions
maxCostUsd?: number;

// In Agent.run(), after addUsage:
if (
  this.maxCostUsd !== undefined &&
  this.costTracker.total().costUsd > this.maxCostUsd
) {
  this.abortController.abort(
    `max-cost-usd exceeded: $${this.costTracker.total().costUsd.toFixed(4)} > $${this.maxCostUsd}`,
  );
  return this.makeResult(response.content, "aborted", iterations);
}
```

**`runAgent` dispatch** (`src/cli/run.ts`): when
`options.model` is not provided but `parsed.provider` is,
call `createProviderAdapter({ provider, model: parsed.model })`
and use the result. Throw `CliError(EXIT_USAGE)` if neither
is set, or if the env var for the chosen provider is
missing.

**Tests:** ~25 in `test/cli-provider-dispatch.test.ts`
covering:
- `createProviderAdapter` (4 providers × 2 cases each =
  ~8, plus unknown-provider + custom-model + custom-env
  = ~3, plus ollama-with-OLLAMA_BASE_URL = 1).
- `runAgent` with `--provider openai` resolves the
  adapter (3 cases: success, missing key, no provider).
- `Agent.maxCostUsd` cap (5 cases: no cap, cap=0, cap
  exceeded, cap not exceeded, cap checks per-iteration
  not at end).

**Why this is the biggest remaining chunk:** the harness
is demoable but not usable without a real LLM. After F7,
the bin script's `--model` + `--provider` flags light up
for real providers. Cost tracking unlocks the
`costReasonableForWork` verifier rule and the `max-cost-usd`
CLI cap (currently a no-op stub).

**Out of scope:**
- Streaming. v0 uses non-streaming `complete()`. Streaming
  is a UX improvement, not a correctness one.
- Retry / backoff. v0 fails fast on a 5xx; the caller can
  retry at a higher level. Per-design the loop is one-shot
  per prompt.
- Vision / image inputs. v0 only translates text and
  tool blocks. Image content is a future chunk.

### 6.3 F8 — Phase 2: `envoy-harness-adapter` (Package 3)
**Status:** pending. The MAP integration.

**Reference:** design.en.md §11 (the reference MAP
adapter). The interface is `AgentAdapter` from
`@envoymesh/agent-adapter` (Package "agent-adapter",
in the EnvoyMesh monorepo). Reference implementations:
`OpenClawAdapter`, `PiAdapter` in
`packages/agent-adapter/src/`.

**Goal:** `EnvoyHarnessAdapter implements AgentAdapter`
— the home-team adapter. The adapter is a thin bridge
that knows about both envoy-harness (Package 1) and the
mesh (Package 2 + `@envoymesh/agent-adapter`).
**envoy-harness stays mesh-agnostic**; the adapter is
the only place that imports both.

**Scope (sub-chunks):**

| ID | Scope | Files | Status |
|----|-------|-------|--------|
| **F8.0** | Repo scaffold: convert envoy-harness to a pnpm workspace; add `packages/envoy-harness-adapter/`. | new pnpm-workspace.yaml, tsconfig.base.json, packages/envoy-harness-adapter/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts,src/index.ts,test/smoke.test.ts,README.md} | ✅ done |
| **F8.1** | `ENVOY_HARNESS_SKILLS` catalog (5 skills: code-edit, code-review, doc-search, bash-run, plan). Skill → tool-set mapping (which tools are available per skill). | `src/skills.ts`, `test/skills.test.ts` | ✅ done |
| **F8.2** | `EnvoyHarnessAdapter` class — `describeSkills`, `buildManifest` (unsigned — orchestrator signs), `execute` (translates ExecuteInput → local Agent.run → wire AgentResult), `verify` (uses local verifier rules). | `src/adapter.ts`, `test/adapter.test.ts` | ✅ done |
| **F8.3** | Local ↔ wire translation: `localToWireResult`, `localToWireContent`, `localToWireBlock`, `localToWireMetrics`. Stable schemaRefs for tool calls + tool results (`envoymesh://tool-call/v1`, `envoymesh://tool-result/v1`). | `src/translation.ts`, `test/translation.test.ts` | ✅ done |
| **F8.4** | Sign result helper + integration with `@envoymesh/identity`. Adapter takes `signResult` as constructor dep (DI pattern, per OpenClawAdapter). | `src/adapter.ts` (constructor + execute), `test/adapter.test.ts` | ✅ done |
| **F8.5** | Skill execution: build prompt per skill, set up tool set, run local `Agent.run()`, return wire `SignedAgentResult`. `defaultBuildAgentFactory` exported. Use `FakeModel` in tests. | `src/adapter.ts`, `test/adapter.test.ts` | ✅ done |
| **F8.6** | Runtime-specific verifier. v0: first-cut deterministic (non-empty + non-echo). Future chunk wires the local verifier rules. | `src/adapter.ts:verify`, `test/adapter.test.ts` | ✅ done (v0 first-cut) |
| **F8.7** | Public API surface: re-export `EnvoyHarnessAdapter`, `ENVOY_HARNESS_SKILLS`, types. Update `docs/implementation-plan.md` to mark F8 done. | `src/index.ts`, `docs/implementation-plan.md` | ✅ done |

**Adapter class sketch (per design §11):**

```ts
// src/adapter.ts
import type {
  AgentAdapter,
  BuildManifestInput,
  ExecuteInput,
  VerifyInput,
} from "@envoymesh/agent-adapter";
import type {
  AgentResult as WireAgentResult,
  SignedAgentResult,
  CapabilityManifest,
  SkillDescriptor,
  Verdict,
} from "@envoymesh/protocol";
import { signCanonicalPayload } from "@envoymesh/identity";
import type { Agent as LocalAgent, AgentResult as LocalAgentResult } from "@envoymesh/envoy-harness";

export const ENVOY_HARNESS_VERSION = "0.0.0";

export const ENVOY_HARNESS_SKILLS: ReadonlyArray<SkillDescriptor> = [
  { skillId: "code-edit",  ..., tags: ["code", "edit"] },
  // ... 5 skills total
];

export interface EnvoyHarnessAdapterInput {
  /** The local agent factory — builds a fresh `Agent` per `execute()`. */
  buildAgent: (skillId: string, objective: string) => LocalAgent;
  /** Sign an unsigned wire `AgentResult`. The node controls the key. */
  signResult: (unsigned: WireAgentResult) => SignedAgentResult;
  /** The node's worker peerId. */
  workerPeerId: string;
  /** Optional: env's runtime version. Default: `ENVOY_HARNESS_VERSION`. */
  runtimeVersion?: string;
}

export class EnvoyHarnessAdapter implements AgentAdapter {
  readonly runtime = "envoy-harness" as const;
  // ... describeSkills, buildManifest, execute, verify
}
```

**Local ↔ wire translation (per design §4 + implementation-plan §3):**

| Local (Package 1) | Wire (Package 2 protocol) |
|---|---|
| `ContentBlock` (`type: "text"`, `type: "tool_call"`, `type: "tool_result"`) | `ContentBlock` (`kind: "text"`, etc. — different schema) |
| `Message[]` (transcript) | not in wire — sanitized out |
| `SandboxPolicy` (effective) | not in wire — internal audit |
| `AgentResult.metrics.costUsd` | `AgentMetrics.costUsd` |
| `AgentResult.iterations` | not in wire — replaced by `durationMs` |
| `AgentResult.toolCalls` | not in wire |
| `AgentResult.stopReason` | not in wire — verifier handles quality |
| `AgentResult.content` (local) | wire `content[]` (translated) |

The translation is **lossy** — the wire format is the
public contract, not the internal state. Per the
contemporary protocol schemas, only `content` (text +
tool calls) and `metrics` survive.

**Hard requirements (per AgentAdapter contract):**
- `execute` MUST respect `input.signal` (abort on cancel).
- `execute` SHOULD refuse to start when `costCeilingUsd`
  is too low (the orchestrator's `chain-budget-ledger` is
  the authoritative gate; the adapter is the first line).
- `verify` returns one or more verdicts. Multiple verdicts
  on the same result are OR-combined by the orchestrator.
- `signResult` is provided by the node (the adapter does
  not invent or hold a key).

**Why a separate package (not a workspace in envoy-harness):**
- The adapter is the **only** place that knows about both
  envoy-harness and the mesh. envoy-harness Package 1
  must stay mesh-agnostic (design target #2 + invariant).
- A new sibling repo `envoy-harness-adapter/` matches the
  user's existing pattern (separate repos for separate
  packages; cross-repo deps via npm). The alternative —
  converting envoy-harness to a pnpm workspace — is
  invasive (CI, package.json, build) and the design
  doesn't require it.
- A separate repo also makes the dependency direction
  one-way: `envoy-harness-adapter` depends on
  `envoy-harness`, never the reverse. The
  `AgentAdapter` interface comes from
  `@envoymesh/agent-adapter` (EnvoyMesh monorepo).

**Tests:** ~30 across 6 test files (skills, adapter,
translation, execute, verify, smoke). All use `FakeModel`
for the local `Agent` (per F7.5 design — no real network
calls in tests). The `signResult` dep is a fake that
just stamps a SHA-256 of the canonical JSON.

**Why this is a Phase 2 milestone (per design §22):**
Phase 2 = "EnvoyHarnessAdapter implements the full MAP
surface". F8.0-F8.7 are the path. After F8.7, the
adapter is fully functional (manifest broadcast, task
submission, 3-tuple reputation book local-only,
arbitration reads work). Subsequent chunks (Phase 4) add
LSP, team, cron, trace UI, etc.

### 6.4 F8 polish — wire real Ed25519 signing + local verifier rules
**Status:** pending. Two known limitations from the
F8 done-work entry.

**Scope (sub-chunks):**

| ID | Scope | Files | Status |
|----|-------|-------|--------|
| **F8.4+** | `defaultSignResult` helper that wraps `@envoymesh/identity`'s `signCanonicalPayload`. The adapter still takes `signResult` as a DI closure (no behavior change for callers), but the default closure does real Ed25519. Tests use a fake; production uses the real signer. | `src/signing.ts`, `test/signing.test.ts` | ✅ done |
| **F8.6+** | Wire the local verifier rules to the adapter's `verify()`. Map wire `SignedAgentResult` → local `AgentResult` shape (decode structured tool-call/result blocks; synthesize the message list; default the sandbox policy to safe), then run `runVerifierRules` from `@envoymesh/envoy-harness`. Return the verdicts. | `src/verify.ts`, `test/verify.test.ts` | ✅ done |

**Why these are F8 polish (not separate F-chunks):** the
adapter already has the seams — `signResult` is a DI
closure, `verify()` is a method. The polish is just
filling in the default implementations with real
Ed25519 + the local verifier. The behavior change is
additive: callers that inject their own `signResult`
are unaffected; the default just becomes real.

**`defaultSignResult` (F8.4+):**

```ts
// src/signing.ts
import { signCanonicalPayload } from "@envoymesh/identity";
import type { SignResultFn } from "./adapter.js";

/**
 * Build a signResult closure that signs with the given
 * Ed25519 private key (PEM). The closure calls
 * `signCanonicalPayload(unsigned)` and returns the
 * `SignedAgentResult` with the signature field.
 *
 * The adapter does NOT hold a key — the host provides
 * it (typically from `@envoymesh/identity`'s
 * `generateAgentIdentity(ownerId)`).
 */
export function defaultSignResult(
  privateKeyPem: string,
): SignResultFn {
  return (unsigned) => ({
    ...unsigned,
    signature: signCanonicalPayload(unsigned, privateKeyPem),
  });
}
```

**Wire `verify()` (F8.6+):**

```ts
// src/verify.ts
import {
  runVerifierRules,
  DEFAULT_RULES,
  type VerifierRule,
  type Message as LocalMessage,
} from "@envoymesh/envoy-harness";
import type { Verdict, SignedAgentResult, AgentResult as WireAgentResult } from "@envoymesh/protocol";
import type { VerifyInput } from "@envoymesh/agent-adapter";
import { localToWireBlock } from "./translation.js";

/**
 * Map a wire `AgentResult` to a local `AgentResult` shape
 * for the verifier. The wire format has typed content
 * blocks; the local verifier expects `messages` +
 * `sandboxPolicy` + `content` (text + tool calls + tool
 * results). The structured tool-call/result blocks are
 * decoded back to the local shape.
 */
function wireToLocalAgentResult(
  wire: WireAgentResult,
): {
  content: ReadonlyArray<{ type: "text" | "tool_call" | "tool_result"; ... }>;
  messages: ReadonlyArray<LocalMessage>;
  sandboxPolicy: { ... };
  metrics: { ... };
} {
  // 1. Decode content blocks (text + structured tool_call/result).
  // 2. Build a synthetic message list (the wire doesn't have a
  //    full transcript; we approximate from content).
  // 3. The sandbox policy isn't on the wire (it's internal
  //    audit). Default to a safe policy.
  ...
}

export function runLocalVerifier(
  input: VerifyInput,
  rules: ReadonlyArray<VerifierRule> = DEFAULT_RULES,
): Verdict[] {
  const local = wireToLocalAgentResult(input.result);
  return runVerifierRules(local, rules);
}
```

**Tests:**
- F8.4+: ~5 tests for `defaultSignResult` (correct
  signature shape, real Ed25519 round-trip, malformed
  key throws, signature covers `raw`).
- F8.6+: ~8 tests for `runLocalVerifier` (empty
  content → fail, non-empty content → pass,
  tool-call-heavy result → uses tool-aware rules,
  unknown rule throws, default rules used when none
  provided, custom rules list respected).

**Out of scope:**
- Real Ed25519 key generation. The host provides the
  key (via `@envoymesh/identity`); the adapter
  doesn't generate.
- Wiring `verify()` to use cross-agent rules (e.g. when
  the orchestrator asks the adapter to verify a
  result produced by another adapter). v0: the
  adapter only verifies its own results.
- Caching the local-ruleset in the adapter. The
  caller passes the rules (default: `DEFAULT_RULES`).

### 6.5 F9 — Phase 4: Production-grade (LSP, team, cron, trace UI, per-call approval, cross-verify)
**Status:** pending. Per design §22 Phase 4 is **ongoing**
(not a fixed milestone). The 5 features are independent;
each is a separate F9.x sub-chunk.

**Sub-chunks (in priority order; user can pick any to start):**

| ID | Scope | Source | Status |
|----|-------|--------|--------|
| **F9.1** | Per-call approval callback (Penguin style). When the model tries a sensitive action (e.g. bash with workspace-write), pause the agent loop and call a host-provided `askHandler` callback. The callback returns a decision (allow / deny / modify). The agent resumes with the decision. The host decides UX (Tauri prompt, headless log, etc.). | design §10.4 (Penguin per-call approval sketch), §8.1 hook events | ✅ done |
| **F9.2** | LSP client (parity with claw-code lane 8). `LspClient` class that wraps the LSP protocol over stdio. Auto-start language servers for projects the harness is reading/writing. Provides `definition`, `references`, `hover`, `diagnostics` to the agent as tools. | claw-code parity lane 8 | ✅ done (F9.2.1 + F9.2.2 + F9.2.3) |
| **F9.3** | Team + cron (parity with claw-code lane 6). Multi-agent team definition (a team is a graph of agents + roles + delegation rules). Cron triggers (a team runs on a schedule). Saved as TOML config (`06-team-cron.toml`). v0: read the TOML, run the team in-process; no actual cron daemon. | claw-code parity lane 6, design §25 (parity dir) | ✅ done (F9.3.1 + F9.3.2 + F9.3.3) |
| **F9.4** | Trace observability UI. The bin script gains `--json` mode (already accepted, currently ignored) that streams every agent decision + hook fire + tool call + verifier verdict as JSON Lines to stdout. A separate viewer (out-of-scope for this repo) renders the stream. v0: just the JSON Lines output; the viewer is a downstream concern. | design §19 (CLI), existing `--json` arg | ✅ done (F9.4.1 + F9.4.2 + F9.4.3) |
| **F9.5** | Cross-agent verification. The `verify()` path can take an optional `crossVerifyWith` closure. When provided, the adapter calls it on the result and returns the cross-verify verdict in addition to its own. The orchestrator combines per design §6.2 (OR-of-pass, AND-of-fail). v0 in this chunk: a default cross-verify closure that re-runs the same skill on a different `ModelAdapter` (e.g. cheap local model vs. expensive GPT-4). | design §12.4 (4-source cascade), MAP §CrossAgentDisagreementVerifier | ✅ done (F9.5.1 + F9.5.2) |

**Why priority order:** F9.1 is the smallest and most
user-facing. Per-call approval is a daily UX need
(stop the agent from doing something dangerous); the
infrastructure (hooks + abort) is already in place.
F9.5 is largest (needs cross-adapter wiring).

**Out of scope for F9.x:**
- Streaming responses (LLM SSE). The agent's
  `complete()` is non-streaming; a future chunk
  could add `completeStreaming()`.
- A web UI for trace rendering. F9.4 emits JSON
  Lines; the viewer is downstream.
- Real cron daemon. F9.3 reads a cron config and
  runs in-process; system cron (or k8s CronJob) is
  the host's responsibility.
- Auto-merge / auto-commit. Per-call approval can
  ALLOW an action, but the action is the model's
  responsibility; F9.1 doesn't add new actions.
- Multi-model routing (router → cheap-or-expensive
  based on task). F9.5 is the closest chunk to this
  but the user must opt in via the crossVerifyWith
  closure.

**Sub-chunk template (per F9.x):**
1. **Plan in the doc first.** Expand the relevant
   F9.x section with the design snippet, types,
   tests, out-of-scope items. Commit separately.
2. **Build the data layer** (types, file I/O).
3. **Wire the algorithm** (the main logic, with
   tests).
4. **Wire the integration** (host surface:
   `AgentOptions` field, `RunOptions` field,
   `--cli-flag`).
5. **Update the doc** (move from §6.5 to §3 done
   work). Change log entry.

**Why F9.1 first (over LSP or team):** per-call
approval is a safety feature — without it, the
agent can run any bash command in workspace-write
mode without confirmation. The agent loop already
fires the `PreToolUse` hook; the hook can already
block; what's missing is the host integration. ~5
commits, ~15-20 new tests.

**F9.1 plan (per-call approval):**

**The flow (Penguin style):**
1. Tool call comes in (e.g. `bash("rm -rf /")`).
2. `firePreToolUse` returns `HookDecision` with a new
   `kind: "ask"` variant.
3. The agent loop sees the `ask` decision and pauses.
4. The loop calls `AgentOptions.askHandler({
   tool: call.name, args: call.args, question, options })`
   and awaits the host's response.
5. The host returns `AskDecision`:
   - `{ kind: "allow" }` — run the tool as-is.
   - `{ kind: "deny", reason }` — tool result is
     `"denied by user: <reason>"` with `isError: true`.
   - `{ kind: "modify", args }` — run the tool with
     the modified args (re-validates against the
     zod schema).
6. The agent resumes. The transcript records the
   ask (and the decision) for audit.

**Type changes (additive):**

```ts
// src/types.ts — add to HookDecision
export type HookDecision =
  | { kind: "continue" }
  | { kind: "modify"; modified: unknown }
  | { kind: "block"; reason: string }
  | { kind: "add-context"; content: string }
  | {
      /** F9.1: ask the user (or the host) to approve. */
      kind: "ask";
      question: string;
      /** Suggested options; the host may use them or replace. */
      options?: ReadonlyArray<{ id: string; label: string }>;
    };

// src/types.ts (new) — the host's response
export type AskDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "modify"; args: Record<string, unknown> };

/** The hook's request to the host. */
export interface AskRequest {
  /** The tool the model wants to call. */
  tool: string;
  /** The model's args. The host shows these to the user. */
  args: unknown;
  /** A human-readable question (e.g. "Run bash with this command?"). */
  question: string;
  /** Suggested options; the host may use them. */
  options?: ReadonlyArray<{ id: string; label: string }>;
  /** Abort signal: if the user cancels, the ask is cancelled. */
  signal: AbortSignal;
}

export type AskHandler = (req: AskRequest) => Promise<AskDecision>;
```

**Agent integration:**

```ts
// src/agent.ts — AgentOptions
interface AgentOptions {
  // ... existing ...
  /** F9.1: per-call approval handler. When undefined,
   *  `kind: "ask"` decisions fall back to deny (safe default). */
  askHandler?: AskHandler;
}

// src/agent.ts — executeToolCall (after firePreToolUse)
const preDecision = await this.firePreToolUse(call);
if (preDecision.kind === "block") {
  // ... existing ...
}
if (preDecision.kind === "ask") {
  const askReq: AskRequest = {
    tool: call.name,
    args: call.args,
    question: preDecision.question,
    ...(preDecision.options ? { options: preDecision.options } : {}),
    signal: this.abortController.signal,
  };
  const decision = this.askHandler
    ? await this.askHandler(askReq)
    : { kind: "deny" as const, reason: "no ask handler configured" };
  if (decision.kind === "deny") {
    this.appendToolResult(call.id, `denied by user: ${decision.reason}`, true);
    return;
  }
  if (decision.kind === "modify") {
    call.args = decision.args; // re-validate below
  }
  // decision.kind === "allow" → fall through to the tool runner
}
```

**CLI integration (B.4):**
- `RunOptions.askHandler?: AskHandler` — the CLI
  forwards a handler to the agent.
- Default: a built-in handler that writes a
  one-line "ask" record to stderr (`envoy-harness:
  ask: bash with command="rm -rf /"? — denied by
  default (no UI handler)`) and returns deny. This
  makes the bin script safe in headless contexts.
- Production (Tauri, web, etc.) injects a real UI
  handler via the host binding.

**Tests (~15-20):**
- Hook returns `ask` → agent calls handler.
- Handler returns `allow` → tool runs as-is.
- Handler returns `deny` → tool result is "denied by
  user: <reason>", isError: true.
- Handler returns `modify` → tool runs with modified
  args (re-validated; invalid modified args fail the
  tool with a zod error).
- No handler configured → defaults to deny.
- Ask request receives the right fields (tool, args,
  question, options, signal).
- Ask with an aborted signal → handler is called
  with the signal; the host decides.
- Per-call approval is **additive**: existing
  `block` / `continue` / `add-context` decisions
  are unchanged.
- The transcript records the ask + decision for
  audit (the assistant message + the tool result
  with "denied by user: ..." form a clear narrative).

**Out of scope:**
- Tauri / web UI. The host integration is out of
  scope for this repo (the user app binds its own
  handler).
- Timeout on the ask. The host decides its own
  timeout; the agent's `abortSignal` propagates so
  a host that wants to cancel an in-flight ask
  (e.g. on shutdown) can.
- Persistent permission grants. Per-call only;
  v0 is the floor.

---

**F9.2 plan (LSP client + 4 tools):**

**Why F9.2 next (after F9.1):** the agent
already has read_file + bash + grep, but lacks
the "navigate code" tools that make code-edit
agents actually productive (jump to definition,
find references, hover for type info, surface
diagnostics). The LSP protocol is the standard
way to get these; wrapping it as 4 tools gives
the model real IDE-grade capabilities.

**v0 scope (this commit + a follow-up):**
- `LspClient` interface — 4 ops: `definition`,
  `references`, `hover`, `diagnostics`.
- `NoopLspClient` — returns empty results;
  default when LSP is disabled.
- `MockLspClient` — scriptable responses; for
  tests.
- `StdioLspClient` — JSON-RPC over stdio; talks
  to a real language server (e.g.
  `typescript-language-server`).
- `LspManager` interface — routes a file path
  to the right `LspClient` (per language).
- `StaticLspManager` — pre-configured map of
  file-extension → `LspClient`.
- 4 tools: `lsp_definition`, `lsp_references`,
  `lsp_hover`, `lsp_diagnostics`. Each calls
  the manager with the file path.
- `AgentOptions.lspManager?` — when provided,
  the 4 tools are auto-registered. No manager
  → no LSP tools (no overhead).

**v0+1 (deferred, follow-up):**
- Auto-spawn language servers per file
  extension (e.g. detect `.ts` → spawn
  `typescript-language-server`).
- Server lifecycle (start, restart on crash,
  stop on shutdown).
- Multi-root workspaces.
- Document symbols, formatting, code actions
  (4 listed ops only for v0).

**Why this scope:** the LSP protocol is
complex; the JSON-RPC + Content-Length framing
+ server-initiated requests + initialize
handshake is the bulk of the work. By splitting
"interface + tools" (F9.2) from "auto-spawn
servers" (F9.2+1), we get the tool surface
landed and testable with a mock, then the
production wiring later. The first chunk is
useful (any host with a pre-configured manager
can use the tools); the second adds zero-friction
auto-spawn.

**Type sketch:**

```ts
// src/lsp/types.ts
export interface LspLocation {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface LspHover {
  contents: string;
  file: string;
  line: number;
  column: number;
}

export interface LspDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  code?: string | number;
}

export interface LspClient {
  definition(file: string, line: number, column: number): Promise<LspLocation[]>;
  references(file: string, line: number, column: number): Promise<LspLocation[]>;
  hover(file: string, line: number, column: number): Promise<LspHover | null>;
  diagnostics(file: string): Promise<LspDiagnostic[]>;
  close(): Promise<void>;
}

export interface LspManager {
  /** The LspClient for `file`'s language, or null. */
  forFile(file: string): LspClient | null;
  /** Close all clients. */
  closeAll(): Promise<void>;
}
```

**Tool sketch:**

```ts
// src/lsp/tools.ts
export function makeLspTools(manager: LspManager): Tool[] {
  return [
    {
      name: "lsp_definition",
      description: "Find the definition of the symbol at line/column.",
      parameters: z.object({
        file: z.string(),
        line: z.number().int().nonnegative(),
        column: z.number().int().nonnegative(),
      }),
      async execute({ file, line, column }, _ctx) {
        const client = manager.forFile(file);
        if (!client) return { content: { error: "no LSP client for file" } };
        const locs = await client.definition(file, line, column);
        return { content: { locations: locs } };
      },
    },
    // lsp_references, lsp_hover, lsp_diagnostics: same pattern
  ];
}
```

**Agent integration:**

```ts
// src/agent.ts — AgentOptions
interface AgentOptions {
  // ... existing ...
  /** F9.2: LSP manager. When provided, the 4 LSP
   *  tools are auto-registered. */
  lspManager?: LspManager;
}

// In Agent constructor (after ToolRegistry setup):
if (options.lspManager) {
  for (const tool of makeLspTools(options.lspManager)) {
    this.tools.register(tool);
  }
}
```

**CLI integration:**
- `RunOptions.lspManager?: LspManager` — host
  provides a pre-configured manager.
- Default: no manager (LSP off; CLI runs as
  before).
- v0+1: a `--lsp` flag that boots
  `typescript-language-server` for `.ts` / `.tsx`
  files in the cwd. (Out of scope for this
  chunk.)

**Tests (target: ~15-20):**
- `NoopLspClient` returns empty arrays / null.
- `MockLspClient` returns scripted responses.
- `StaticLspManager` routes by file extension.
- `StaticLspManager` returns null for unknown
  extensions.
- `lsp_definition` tool calls
  `manager.forFile(file)` then
  `client.definition(...)`.
- The 4 tools handle "no client" (return
  `{ error: "no LSP client for file" }`).
- `AgentOptions.lspManager` registers all 4
  tools.
- `AgentOptions` without `lspManager` doesn't
  register LSP tools (verify tool list).
- `LspManager.closeAll()` is called when the
  agent finishes.
- `StdioLspClient` round-trips an `initialize`
  request and a `textDocument/definition`
  request (uses a fake stdio pair — no real
  server).
- `StdioLspClient` parses `Content-Length` headers
  correctly.
- `StdioLspClient` handles server-initiated
  notifications (no-op for v0).
- `StdioLspClient` rejects requests after
  `close()`.

**Out of scope for v0:**
- Real language server auto-spawn (F9.2+1).
- Document symbols, formatting, code actions.
- Multi-root workspaces.
- Server-initiated requests that need a
  response (we accept them but don't reply in
  v0; v0+1 adds a `registerHandler` API).
- Cancellation tokens in flight (we
  fire-and-await; the `AbortSignal` from the
  tool context cancels the stdio write).

**Sub-chunk breakdown (planned):**
1. **F9.2.1** — types + NoopLspClient +
   MockLspClient + StaticLspManager + tests.
2. **F9.2.2** — StdioLspClient (real JSON-RPC
   over stdio) + tests with a fake stdio pair.
3. **F9.2.3** — 4 tools + AgentOptions
   integration + agent-level tests.
4. **F9.2+1** (follow-up) — auto-spawn
   language servers, real-server test in CI.

---

**F9.4 plan (--json trace mode):**

**Why F9.4 next (after F9.2):** debugging an agent
run is the most common production need. Today, the
only way to see what the agent did is the final
text + the transcript. For multi-step runs with
tool calls, the trace is unreadable in text form.
JSON Lines is the lowest-friction observability
format (one event per line, easy to grep, easy to
pipe to `jq`); the viewer is a downstream concern.

**v0 scope (this chunk):**
- `TraceEvent` discriminated union — 6 kinds:
  `agent_start`, `model_response`, `tool_call`,
  `tool_result`, `agent_end`, `error`.
- `Tracer` interface — `emit(event: TraceEvent)`.
- `NullTracer` — default; no-op.
- `JsonLinesTracer` — writes each event as one
  line of JSON to a `WritableStream`.
- `AgentOptions.tracer?: Tracer` — the agent
  calls `tracer.emit(...)` at 5 points.
- CLI `--json` flag (already accepted, currently
  ignored) wires a `JsonLinesTracer` to stdout.
- The trace runs ALONGSIDE the human-readable
  output; `--quiet` still works the same way.

**Out of scope for v0:**
- A web UI for trace rendering. F9.4 emits JSON
  Lines; the viewer is a downstream concern (a
  separate repo).
- Streaming events (one per microtask). v0 emits
  after each agent step. A future chunk can
  switch to live streaming if needed.
- Trace filtering / sampling. v0 is all-or-nothing.
- Hook fire events. Hook fires are observable
  via the `tool_call` / `tool_result` events
  (which include the post-hook decision). Adding
  a separate `hook_fire` event is additive.
- Verifier verdict events. The verifier runs
  OUTSIDE the agent (the orchestrator or the
  harness binary's main flow calls it). v0 has
  no way to know when the verifier runs from
  inside the agent. The `agent_end` event
  includes the transcript (so a downstream
  verifier can be re-run on the trace).

**Type sketch:**

```ts
// src/trace/types.ts
export type TraceEvent =
  | {
      kind: "agent_start";
      ts: string;
      sessionId: string;
      model: string;
      cwd: string;
      tools: ReadonlyArray<string>;
    }
  | {
      kind: "model_response";
      ts: string;
      iteration: number;
      stopReason: ModelResponse["stopReason"];
      content: ModelResponse["content"];
      ...(usage ? { usage: Usage } : {});
    }
  | {
      kind: "tool_call";
      ts: string;
      iteration: number;
      call: ToolCall;
    }
  | {
      kind: "tool_result";
      ts: string;
      iteration: number;
      callId: string;
      result: ToolResult;
      durationMs: number;
    }
  | {
      kind: "agent_end";
      ts: string;
      stopReason: AgentResult["stopReason"];
      iterations: number;
      toolCalls: number;
      metrics: { inputTokens: number; outputTokens: number; costUsd: number };
    }
  | {
      kind: "error";
      ts: string;
      iteration: number;
      message: string;
    };

export interface Tracer {
  emit(event: TraceEvent): void;
}
```

**Implementation sketch:**

```ts
// src/trace/json-lines.ts
export class JsonLinesTracer implements Tracer {
  constructor(private readonly stream: WritableStream) {}
  emit(event: TraceEvent): void {
    this.stream.write(JSON.stringify(event) + "\n");
  }
}

// src/trace/null-tracer.ts
export class NullTracer implements Tracer {
  emit(_event: TraceEvent): void { /* no-op */ }
}
```

**Agent integration:**

```ts
// src/agent.ts — AgentOptions
interface AgentOptions {
  // ... existing ...
  /** F9.4: tracer. When undefined, NullTracer is used. */
  tracer?: Tracer;
}

// At 5 points in the agent loop:
this.tracer = options.tracer ?? new NullTracer();
// 1. Constructor: this.tracer.emit({ kind: "agent_start", ... });
// 2. After model call: this.tracer.emit({ kind: "model_response", ... });
// 3. After validate: this.tracer.emit({ kind: "tool_call", ... });
// 4. After execute: this.tracer.emit({ kind: "tool_result", ... });
// 5. Loop end: this.tracer.emit({ kind: "agent_end", ... });
```

**CLI integration:**
- `--json` already in argv (currently ignored).
  Wire it: when set, `runAgent` constructs a
  `JsonLinesTracer(process.stdout)` and passes it
  to the agent.
- Trace events are interleaved with the final
  result text. v0 doesn't try to be clever about
  "human output vs. trace output"; the user pipes
  one or the other.

**Tests (target: ~15-20):**
- `NullTracer.emit` is a no-op.
- `JsonLinesTracer.emit` writes one JSON line per event.
- `JsonLinesTracer` survives a closed stream (silently
  drops events, doesn't throw).
- `AgentOptions.tracer` is used; without it,
  NullTracer is used (verify by counting emissions).
- `agent_start` event has sessionId, model, cwd, tools.
- `model_response` event has iteration, content, stopReason.
- `tool_call` event has the call args.
- `tool_result` event has durationMs.
- `agent_end` event has stopReason, iterations, metrics.
- `error` event fires on agent errors.
- `--json` flag in argv: the agent's tracer emits
  events to stdout; the bin script's exit code is
  unaffected.
- The trace events are valid JSON Lines (each line
  parses; the whole stream is a valid sequence).
- Trace does not affect the human-readable output
  (the final text is the same with or without --json).

**Out of scope (recap):**
- Web UI for rendering. F9.4 emits JSON Lines;
  the viewer is a separate repo.
- Hook fire events (folded into tool_call /
  tool_result via the post-hook decision).
- Verifier verdict events (verifier runs outside
  the agent in v0).
- Streaming (one event per microtask) — v0 emits
  after each agent step.

**Sub-chunk breakdown (planned):**
1. **F9.4.1** — types + NullTracer + JsonLinesTracer
   + tests for the two tracers.
2. **F9.4.2** — AgentOptions.tracer + the 5 emit
   points + agent-level tests.
3. **F9.4.3** — CLI `--json` integration + bin
   script end-to-end test.

---

**F9.3 plan (team + cron):**

**Why F9.3 now (after F9.4):** once a single
agent is observable (F9.4), the next production
need is multi-agent workflows — a "team" of
agents that hand off work to each other. The
simplest useful v0: a TOML file describing a team
(a list of agents + their delegation rules), and
an in-process runner that executes the team once
per call. No actual cron daemon — the host
(system cron, k8s CronJob, or a simple
`setInterval`) calls `runTeam()` on a schedule.
This matches the design §22 Phase 4 scope
("team + cron, parity with claw-code lane 6, if
useful").

**v0 scope (this chunk):**
- `TeamConfig` type — parsed shape of a TOML
  team config. Fields: `name`, `agents[]` (each
  with `id`, `role`, `system_prompt`,
  `objective`, optional `depends_on[]` for
  delegation), optional `schedule` (a cron
  expression for the host to use).
- Hand-rolled minimal TOML reader (`parseTeamToml`).
  Supports the subset we need: `[section]`,
  `key = "string"`, `key = [array, of, strings]`,
  `key = { nested = "table" }`. No third-party
  dep; ~80 lines.
- `Team` class — takes a `TeamConfig` + a
  `ModelAdapter` + an optional `AgentOptions`
  factory. `runOnce()` executes the team in
  dependency order: agents with no `depends_on`
  run first; downstream agents receive the
  upstream agent's final text as a "context"
  message.
- CLI subcommand `envoy team` (or `--team`)
  reads a TOML file and runs the team once.
  Output is a summary (per-agent final text +
  status).

**Out of scope for v0:**
- A real cron daemon. The host calls
  `runOnce()` on a schedule (system cron,
  k8s CronJob, etc.).
- Parallel agent execution. v0 is sequential
  (topological order on `depends_on`). Parallel
  is a future chunk.
- A team UI / dashboard. The CLI is the surface.
- Conditional delegation (if/else rules). v0 has
  static `depends_on[]` only.
- State persistence. Each `runOnce()` is
  stateless; the orchestrator can persist the
  result if needed.

**TOML format (v0 subset):**

```toml
name = "code-review-team"

[[agents]]
id = "explore"
role = "explore"
system_prompt = "You explore the codebase."
objective = "Find files relevant to ${input}."

[[agents]]
id = "review"
role = "review"
system_prompt = "You review code."
objective = "Review the files from explore."
depends_on = ["explore"]

[schedule]
cron = "0 9 * * *"
```

**Type sketch:**

```ts
// src/team/types.ts
export interface AgentSpec {
  id: string;
  role: string;
  systemPrompt: string;
  objective: string;
  /** IDs of agents whose final text this agent
   *  should receive as a "context" message. */
  dependsOn: ReadonlyArray<string>;
}

export interface ScheduleSpec {
  /** A cron expression (5-field). The host parses
   *  it; v0 doesn't ship a cron parser. */
  cron: string;
}

export interface TeamConfig {
  name: string;
  agents: ReadonlyArray<AgentSpec>;
  schedule?: ScheduleSpec;
}
```

**Algorithm sketch:**

```ts
// src/team/runner.ts
export class Team {
  constructor(opts: {
    config: TeamConfig;
    model: ModelAdapter;
    cwd?: string;
    /** Optional factory for AgentOptions (per-agent
     *  customization). Default: use a single
     *  AgentOptions for every agent. */
    optionsFor?: (spec: AgentSpec) => Partial<AgentOptions>;
  }) { ... }

  async runOnce(input: string): Promise<TeamResult> {
    // 1. Topological sort on depends_on.
    // 2. For each agent in order:
    //    - Build the prompt (objective + upstream results)
    //    - Run the agent
    //    - Capture final text
    // 3. Return the per-agent results + overall status.
  }
}
```

**CLI integration:**
- `envoy-harness team <config.toml> [--input "..."]`
  reads the file, builds a `Team`, calls
  `runOnce()`, prints the summary.
- The `--json` flag works with the team subcommand
  too: per-agent trace events stream to stdout
  alongside the team-level summary.

**Tests (target: ~20-25):**
- `parseTeamToml`: minimal valid config, multiple
  agents, agents with `depends_on`, schedule,
  malformed config (clear error message).
- `Team.runOnce`: empty team, single agent, two
  agents with depends_on, three agents in a
  chain, three agents in a fan-out, missing
  dependency (error), circular dependency
  (error).
- Each agent's prompt includes the upstream
  agent's final text.
- The order is topological: agent A runs before
  agent B if A is in B's depends_on.
- `TeamResult` carries per-agent results in
  execution order.
- CLI: `envoy team config.toml` reads and runs
  the team.

**Out of scope (recap):**
- Real cron daemon. Host invokes runOnce() on
  schedule.
- Parallel agent execution (v0 is sequential).
- Conditional delegation. v0 has static
  `depends_on[]` only.
- State persistence across runs.

**Sub-chunk breakdown (planned):**
1. **F9.3.1** — types + minimal TOML reader +
   tests (no Agent integration; just parse).
2. **F9.3.2** — `Team.runOnce()` with topological
   order + tests.
3. **F9.3.3** — CLI subcommand + end-to-end test.

---

**F9.5 plan (cross-agent verification):**

**Why F9.5 last:** it's the most cross-cutting F9.x
chunk. The verify() path lives in
`@envoymesh/envoy-harness-adapter` (Package 3); a
default cross-verify closure needs another
`EnvoyHarnessAdapter` (or any `AgentAdapter`); the
orchestrator combines the verdicts.

**v0 scope (this chunk):**
- `CrossVerifyFn` type — `(input: VerifyInput) =>
  Promise<Verdict[]>`.
- `EnvoyHarnessAdapter.crossVerifyWith?: CrossVerifyFn`
  — when set, `verify()` calls it and concatenates
  the cross verdicts with the local verdicts.
  Returns the combined array (per the
  `AgentAdapter.verify()` contract: `Verdict[]`).
- `defaultCrossVerify(otherAdapter)` — a factory
  that returns a `CrossVerifyFn`. The closure
  re-runs the same skill on the other adapter
  (using `otherAdapter.execute()` with the same
  objective) and runs the local verifier on the
  new result.
- v0 does NOT pre-combine the verdicts. The
  orchestrator calls `combineVerdicts(verdicts)`
  to collapse the array into a single Verdict.
  This keeps the per-source visibility
  (which rules passed on which model).

**Out of scope for v0:**
- The 4-source cascade (rules + LLM + human +
  cross). v0 has just the existing rules + an
  optional cross-verify. The cascade is a future
  chunk.
- Confidence-weighted voting. v0 concatenates
  verdicts; the orchestrator decides how to
  collapse.
- Cross-verify between DIFFERENT runtime adapters
  (e.g. envoy-harness vs. openclaw). v0 is
  same-runtime only (envoy-harness ↔ envoy-harness).
- Caching the cross-verify result. Each
  `verify()` call re-runs the skill.

**Type sketch:**

```ts
// envoy-harness-adapter/src/verify.ts (new)
/** A function that produces additional verdicts
 *  for a given verify input. The adapter's verify()
 *  calls it after the local verifier and concatenates
 *  the results. */
export type CrossVerifyFn = (input: VerifyInput) => Promise<Verdict[]>;

/** A factory that re-runs the same skill on a
 *  different adapter and returns the local
 *  verifier's verdicts for the new result. */
export function defaultCrossVerify(
  otherAdapter: AgentAdapter,
): CrossVerifyFn {
  return async (input) => {
    const newResult = await otherAdapter.execute({
      skillId: input.result.skillId,
      objective: input.objective,
      inputArtifacts: [],
      costCeilingUsd: 0,
      deadlineMs: 30_000,
      correlationId: input.result.correlationId,
      signal: new AbortController().signal,
    });
    return runLocalVerifier({ result: newResult, objective: input.objective });
  };
}
```

**Adapter integration:**

```ts
// envoy-harness-adapter/src/adapter.ts
export interface EnvoyHarnessAdapterInput {
  // ... existing ...
  crossVerifyWith?: CrossVerifyFn;
}

class EnvoyHarnessAdapter {
  // ...
  async verify(input: VerifyInput): Promise<Verdict[]> {
    const local = await runLocalVerifier(input);
    if (!this.crossVerifyWith) return local;
    const cross = await this.crossVerifyWith(input);
    return [...local, ...cross];
  }
}
```

**Tests (target: ~10-15):**
- `defaultCrossVerify(otherAdapter)` returns a function
  that calls `otherAdapter.execute()`.
- `defaultCrossVerify` returns the local verifier's
  verdicts on the new result.
- `EnvoyHarnessAdapter.crossVerifyWith` is invoked
  during `verify()`.
- Without `crossVerifyWith`, `verify()` returns
  the local verdicts (unchanged behavior).
- `verify()` concatenates local + cross verdicts.
- `defaultCrossVerify` re-runs with the same
  objective + skillId + correlationId.

**Sub-chunks (planned):**
1. **F9.5.1** — `CrossVerifyFn` type +
   `defaultCrossVerify` factory + tests.
2. **F9.5.2** — `EnvoyHarnessAdapter.crossVerifyWith`
   integration + tests.

---

**Why F9.5 last (cross-agent verification):**
needs the most cross-cutting work — adapter
extension, verifier extension, model router
infrastructure. Likely 8-12 commits.

---

### 6.6 F10 — Phase 5: mesh-native sub-agents
**Status:** F10.1 ✅ done, F10.2 ✅ done, F10.3+ pending.

Per design §10.3 ("The task tool — mesh-native sub-agent")
and design invariant #9 ("Sub-agents map to mesh chain steps,
not in-process tasks"). The parent agent calls the `task` tool;
the tool submits to a `MeshSubmitter`; the submitter runs (or
routes) the sub-agent and returns the result. **Mesh-native**
means the seam is the mesh: even when the sub-agent runs
locally, it's an independent session (own id, own AGENTS.md,
own hooks, own permission) — a future `RemoteMeshSubmitter`
swaps in for cross-node execution without code changes.

| ID | Scope | Files | Status |
|----|-------|-------|--------|
| **F10.1** | `MeshSubmitter` interface + `NoopMeshSubmitter`; `LocalMeshSubmitter` + `defaultBuildSubagentFactory`; `task` tool + `AgentOptions.meshSubmitter`; end-to-end via real `Agent.run()`. 4 sub-chunks. | `src/subagent/{types,noop-submitter,local-mesh-submitter,tools,index}.ts`, `src/agent.ts`, 4 test files | ✅ done (4 sub-chunks: F10.1.1 + F10.1.2 + F10.1.3 + F10.1.4) |
| **F10.2** | Parallel sub-agent fan-out (auto-detect "all N task calls" → `Promise.all`) + `maxSubagents` cap (default 8, host-configurable; refuses ALL when exceeded). 1 sub-chunk. | `src/agent.ts`, `test/subagent-parallel.test.ts` | ✅ done (F10.2.1) |
| **F10.3** | Cross-node `RemoteMeshSubmitter` (Package 3) + `SubagentResultSigner` seam (Package 1) + `RemoteSubmitterTransport` interface + `routingHint` field. 3 sub-chunks. | `src/subagent/signer.ts` (new), `src/subagent/local-mesh-submitter.ts` (additive), `packages/envoy-harness-adapter/src/remote-mesh-submitter.ts` (new) | ✅ done (3 sub-chunks: F10.3.1 + F10.3.2 + F10.3.3) |
| **F10.4** | `FanOutSpec` + `FanOutRegistry` (capability-driven fan-out, the user's F10.2 ask). 1 sub-chunk in v0; cost aggregation + progress streaming deferred to F10.5+. | `src/subagent/fan-out.ts` (new), `src/subagent/tools.ts` (additive), `src/agent.ts` (additive `fanOutRegistry?` option), 1 test file | ✅ F10.4.1 done |
| **F10.5** | Cost aggregation (sub-agent `CostTracker` → parent) + progress streaming (sub-agent `TraceEvent`s → parent tracer). 1 sub-chunk. | `src/cost.ts` (additive `addSubagentCost`), `src/subagent/local-mesh-submitter.ts` (additive `parentTracer?`), `src/subagent/tools.ts` (additive `onSubagentComplete?`), `src/agent.ts` (wires both), 1 test file | ✅ done |
| **F10.6** | `subagentOf` field on `TraceEvent` (self-describing event annotation; enables session-grouped UIs + log analyzers + replay tools). 1 sub-chunk. | `src/trace/types.ts` (additive field on `TraceBase`), `src/agent.ts` (additive `subagentOf?` option + private `emit` helper), `src/subagent/local-mesh-submitter.ts` (additive `parentSessionId?` on factory), 1 test file | ✅ done |

**Why the sub-agent path is the mesh-native contract, not in-process:**
Codex and Claude Code create in-process sub-agents — same process, shared
memory, no isolation. EnvoyMesh is a P2P mesh; sub-agents map to chain
steps. Even local sub-agents are independent sessions: own id, own
AGENTS.md, own hooks, own permission. The `MeshSubmitter` seam is the
only thing that knows WHERE the sub-agent runs. v0 ships
`LocalMeshSubmitter`; a future `RemoteMeshSubmitter` swaps in for
cross-node execution.

**v0 limits (deferred to F10.3+):**
- Local execution only (no cross-node routing).
- Result is unsigned (v0: no cryptographic trust needed for local).
- Cost tracking is per-sub-agent (the parent's `maxCostUsd` only counts
  parent's model calls). Host budgets sub-agents separately via
  per-call `cost_ceiling_usd`.
- No capability-driven fan-out (model emits N task calls; v0 honors N
  up to the cap; the host doesn't pre-register fan-out patterns).

---

### 6.7 Phase 6 — what comes next?

**Phase 5 is feature-complete** (F10.1-F10.6). The
mesh-native sub-agent path is shipped.

**Chosen Phase 6 first chunk: F17 — interactive REPL.**
v0 is single-shot (`envoy "do X"` → output → exit).
Codex, Claude Code, and pi all ship a REPL with slash
commands; users want to iterate with the model
interactively without re-spawning. F17 adds a
readline-based REPL activated by `envoy --repl`
(no positional prompt) or by entering REPL mode from
the end of a one-shot run. Single Agent reused
across turns; slash commands operate on local state
(model swap, sandbox change, cost display, etc.).

Other Phase 6 candidates remain deferred until F17
ships and a real use case surfaces for them
(per the "testability wins on tie" principle):

1. **F10.7**: `RemoteMeshSubmitter` impl in EnvoyMesh (mesh-side, not envoy-harness).
2. **F11**: progressive disclosure for `AGENTS.md`.
3. **F12**: per-host tool installation (current workaround: custom factory).
4. **F13**: streaming tool output (current behavior: model waits for full result).
5. **F14**: persistent session log (resume already wired but the log itself is in-memory).
6. **F15**: multi-tier fan-out + dynamic count.
7. **F16**: capability-driven cross-node routing (default `RemoteSubmitterTransport` impl).

#### F17 plan — interactive REPL

**Scope:** readline-based REPL. No TUI (ink/blessed) — plain
readline + ANSI colors. Single Agent reused across turns; slash
commands mutate local state and don't reach the model.

**Why now (and not earlier):** v0 was scoped to single-shot CLI
because that's the easy default. Codex, Claude Code, and pi all
ship a REPL, and users expect one. Tauri app is the primary
host for the interactive surface, but a solo developer who
installs `npm install -g @envoymesh/envoy-harness` on their
laptop has no Tauri app — they need a CLI REPL.

**Sub-chunk breakdown:**

1. ✅ **F17.1 — REPL loop scaffold** (`a0b1c2d`, planned in 9bf4735).
   `--repl` flag activates REPL mode (no positional prompt required;
   `envoy --repl foo` is a `CliError(EXIT_USAGE)`). Readline-based
   prompt (`envoy> `). Single `Agent` constructed once and reused
   across turns (preserves session, hooks, AGENTS.md, permission).
   Non-slash input → sent to `agent.run(input)` as a new turn.
   Exit on `/quit`, `/exit`, or EOF (Ctrl-D). Empty lines ignored.
   Unknown `/command` lines print to stderr as a placeholder
   (F17.2 will replace with the real registry). 13 new tests in
   `test/repl-loop.test.ts`. Public surface: `runRepl` + `ReplOptions`
   + `ReplResult` + `LineReader` re-exported from `@envoymesh/envoy-harness`.
   `agent.run` errors print to stderr but don't kill the REPL —
   the next turn can still run.

2. ✅ **F17.2 — Slash command registry** (planned 9bf4735; next
   commit). Built-in slash commands that operate on local
   state (no model call):
   - `/help` — list all commands
   - `/model <id>` — swap model (rebuild adapter on next turn)
   - `/provider <name>` — swap provider
   - `/sandbox <mode>` — change permission mode for next turn
   - `/approval <mode>` — change approval policy
   - `/clear` — reset session transcript (keep AGENTS.md)
   - `/cost` — print accumulated cost + token usage
   - `/status` — print current model/provider/sandbox/turn count
   - `/quit` (alias: `/exit`) — exit REPL

   Dispatcher: input starting with `/` → `parseCommandLine` →
   look up handler → invoke. Unknown command → help text.
   `ReplCommand { name, description, handler: (args, ctx) => Promise<void>, hidden? }`
   registry is open (host can register custom commands via
   `AgentOptions.replCommands?` — additive, not in F17.1).
   ~200 LoC + tests. Tests: each built-in works; unknown
   command → help; order-independent; help is correct.

3. **F17.3 — History persistence.** `~/.local/state/envoy-harness/history`
   (or `$ENVOY_HARNESS_HISTORY`). Readline-managed (use
   `readline.createInterface({ historySize: 1000 })` with
   manual load/save). Each line is the literal input (slashes
   preserved). On REPL start, load file (if exists); on REPL
   exit, write file (truncate + append). Override via env var
   or `--history <path>`. ~50 LoC + tests. Tests: history
   loads on start, persists across restarts, ignores lines
   longer than the cap.

4. **F17.4 — Tests + e2e.** Wire tests across F17.1–F17.3:
   end-to-end REPL session (launch with mock model, type a
   prompt, verify output, `/model foo`, type another prompt,
   verify output uses new model, `/quit`, verify history file
   exists). Snapshot test for the help text. Error path tests
   (invalid model id, agent throws, agent loop times out).
   ~100 LoC of tests. Total new tests: ~30 across the 4
   sub-chunks.

**Type sketch** (the load-bearing shapes — see `src/cli/repl/`):

```ts
// src/cli/repl/types.ts
export interface ReplOptions {
  /** Same shape as RunOptions minus the prompt. */
  model: ModelAdapter;
  hooks?: HookRegistry;
  cwd?: string;
  /** Path to the history file. Default: ~/.local/state/envoy-harness/history. */
  historyPath?: string;
  /** Host-registered slash commands. Built-ins always win on name collision. */
  customCommands?: ReadonlyArray<ReplCommand>;
}

export interface ReplCommand {
  name: string;
  description: string;
  hidden?: boolean;
  /** Run the command. Throw to surface the error to the user. */
  handler: (args: string[], ctx: ReplContext) => Promise<void>;
}

export interface ReplContext {
  /** The current Agent. Slash commands can mutate it (e.g. swap model). */
  agent: Agent;
  /** Current run args (model, provider, sandbox, approval, cwd, etc.). */
  args: RunParsedArgs;
  /** Streams. */
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}
```

**Out of scope for F17 (defer to a later chunk if needed):**

- **TUI rendering** (ink / blessed). Plain readline + ANSI
  colors is enough for v0; a TUI is a separate, much bigger
  feature (3000+ LoC).
- **Multiline input editing.** Readline gives single-line
  editing with up-arrow history. Multiline is a separate
  feature (use `node:readline`'s `terminal: true` + heredoc,
  or switch to a third-party library).
- **Tab completion for slash commands.** Readline's built-in
  completion is for file paths; slash completion is a F17.5
  candidate (~30 LoC if F17.5 is needed).
- **Streaming tool output to the REPL.** F13 covers JSON
  streaming. For the REPL, the user sees the final
  `tool_result` block (current behavior). A live-progress
  REPL display is a future chunk.
- **Sub-agent spawning from inside the REPL.** The `task` tool
  already works through the agent loop; the REPL just sees
  the tool result. No special-casing needed.
- **Tauri app integration.** The Tauri app has its own UI;
  the REPL is for solo CLI use, not for the Tauri host.

**Self-review checklist (per sub-chunk):**
- [ ] `--repl` activates the REPL; no positional prompt required.
- [ ] Single `Agent` reused across turns; session id stable.
- [ ] Non-slash input → `agent.run(input)` → output to stdout.
- [ ] Slash commands don't reach the model; only built-ins.
- [ ] `/quit` / Ctrl-D exit cleanly (return code 0; no
      unhandled rejections).
- [ ] History persists across restarts.
- [ ] Tests cover every built-in command + each exit path.
- [ ] e2e: launch REPL, type prompt, see response, `/model`,
      type prompt, see new response, `/quit`.

**Sub-chunk template (per F17.x):** same as F10.1.x:
plan (this section) → data layer (types) → algorithm
(loop + dispatch + persistence) → audit trail (tests)
→ update the doc (§3 done + §6.7 status + §10).

---

## 7. F6 sub-chunk archive (Phase 3 §13.3 — federated scoreboard)

F6 was planned in §6.1 and split into 4 sub-chunks. The
plan below is preserved for reference (and so the next
federated-style feature can follow the same template).

**Sub-chunk template** (apply to new features):

1. **Plan in the doc first.** Expand the relevant §6.x
   section with the sub-chunk breakdown, types to add,
   tests, and out-of-scope items. Commit the plan
   separately. **Don't start coding without a plan in
   this file.**
2. **Build the data layer first** (types, file I/O). This
   is the smallest verifiable unit. Commit.
3. **Wire the algorithm** (the main logic, with tests).
   Commit.
4. **Wire the audit trail** (recording, error paths).
   Commit.
5. **Wire the CLI** (argv, runner dispatch). Commit.
6. **Update the doc.** Move the planned sub-chunks from §6
   to §3 (done work). Update the status table. Add to the
   change log. Commit.

F6.1-F6.4 followed this template. See the commits
`7aa6085` (F6.1), `362ae76` (F6.2), `8076656` (F6.3),
`fe0c5df` (F6.4).

### 6.2 Phase 2 — real LLM adapters + cost tracking (§14)
**Status:** pending. This is the biggest remaining chunk.

**Scope:**
- `src/llm/openai.ts` — OpenAI adapter (`ModelAdapter`).
- `src/llm/anthropic.ts` — Anthropic adapter.
- `src/llm/deepseek.ts` — DeepSeek adapter.
- Provider dispatch in the bin script: `--provider openai
  | anthropic | deepseek` resolves to the right adapter.
- `src/cost.ts` — token counting + USD cost tracking.
  Hook into `PostToolUse` to attribute cost to the call.
  Wire into `AgentResult.metrics.costUsd`.
- Update `costReasonableForWorkRule` to use the new metrics
  (was returning null in v0).

**Tests:** each adapter has a `FakeHttpServer` mock that
asserts request shape; cost tests cover token-to-USD for
each model.

**Why second:** unblocks real-world use. Without a real
adapter, the harness is demoable but not usable.

### 6.3 Phase 2 — `envoy-harness-adapter` (Package 3)
**Status:** pending. The MAP integration.

**Scope:**
- New package: `packages/envoy-harness-adapter/`.
- Translates local types to wire types and back.
- Wires the harness to EnvoyMesh's manifest broadcast,
  task submission, and the 3-tuple reputation book.
- The verification chain (worker → verifier → 4-source
  cascade) is what the adapter submits, not the worker
  itself.

**Tests:** the EnvoyMesh repo has
`packages/protocol/test/agent-adapter-integration.test.ts`
verifying coexistence. The adapter's own tests live in
its package.

**Why third:** the local harness is the foundation. The
adapter sits on top. Building the adapter without a real
LLM adapter is possible (FakeModel in tests) but not
useful.

---

## 8. How to extend (recipes)

### Add a new tool
1. Create `src/tools/builtin/<name>.ts`. Use `Tool<TParams>`
   with a zod schema. Export a singleton.
2. Add to `BUILTIN_TOOLS` in `src/tools/builtin/index.ts`.
3. Tests in `test/tools-<name>.test.ts`.

### Add a new verifier rule
1. Add to `src/verifier/rules/index.ts` following the
   `VerifierRule` shape.
2. Append to `DEFAULT_RULES`.
3. Add tests in `test/verifier.test.ts`.

### Add a new hook event
1. Add the event name to `HookEventNameSchema` in
   `src/types.ts`.
2. Fire it in the appropriate site
   (e.g. `agent.ts` for PreToolUse, the CLI for
   SessionStart).
3. The `HookRegistry.fire()` accepts the new name; handlers
   register with the same name.

### Add a new subcommand
1. Add a new `*ParsedArgs` interface in `src/cli/argv.ts`.
2. Add a parser function (e.g. `parseFooArgs`).
3. Add a `case "foo"` to `parseArgs` dispatch.
4. Add a `runFoo(parsed, options, stdout, stderr)` in
   `src/cli/run.ts`.
5. Add a result type and a `*RunResult` interface in
   `src/cli/run.ts`. Add to the `CliRunResult` union.
6. Update `formatHelp` to document the new subcommand.
7. Tests in `test/cli.test.ts`.

### Add a new dependency
1. Update `package.json`.
2. Run `pnpm install`.
3. Verify the dep is necessary (per design rule
   "Prefer maintained dependencies over hand-rolling").
4. Document the dep in this file (§5 Known issues if it
   has caveats).

---

## 9. References

- **Design (English, source of truth):** `docs/design.en.md`
- **Design (Chinese):** `docs/design.zh.md`
- **Phase 1+3 PR description:** `.github/PHASE-1-3-REVIEW.md`
- **MAP protocol (in EnvoyMesh):** `EnvoyMesh/docs/improving-agent-network.en.md`
- **Penguin self-evolve reference:** `penguin-harness/examples/self-improving-agent/self-evolve.ts`
- **Codex AGENTS.md reference:** `codex-rs/core/src/agents_md.rs:1-90`
- **Codex hook runtime reference:** `codex-rs/core/src/hook_runtime.rs:8-32`
- **Pi TaggedError (model error type):** `pi/packages/agent/src/harness/agent-harness.ts:28-55`
- **claw-code bash parity fixture:** `claw-code/PARITY.md:67`

---

## 10. Change log

- **2026-08-18**: Initial implementation plan. Phase 1 (1-4d)
  and Phase 3 (5a-5e) complete. 305 tests, 27 source files,
  16 test files. F6 (federated scoreboard) is the next
  planned sub-chunk.
- **2026-08-18 (F6 plan)**: Expanded §6.1 with F6.1-F6.4
  sub-chunk breakdown (PeerSource interface, local 5-step
  gate, federated adoption records, CLI --pull flag). Plan
  in place; implementation to follow.
- **2026-08-18 (F6 done)**: F6.1-F6.4 all committed. Phase 3
  §22 milestone is now "4 of 4 done". 330 tests, 29 source
  files, 19 test files. Updated §2 (status + per-module
  table), §3 (done work for F6.1-F6.4), §5 (new risks 5.9,
  5.10), §6 (F6 marked done, F7/F8 renumbered), §7 (Phase 3
  status updated), §10 (this entry). Next: F7 (real LLM
  adapters + cost tracking).
- **2026-08-18 (F7 plan)**: Expanded §6.2 with F7.1-F7.5
  sub-chunk breakdown (cost tracking module, HTTP client
  abstraction, OpenAI/Anthropic/DeepSeek adapters, provider
  dispatch in bin). Type changes documented (ModelResponse.usage,
  AgentResult.metrics). Plan in place; implementation to
  follow.
- **2026-08-18 (F7.1)**: Cost tracking module landed.
  `src/cost.ts` (TokenPrice, DEFAULT_PRICING, computeCost,
  CostTracker with per-call modelOverride for multi-model
  attribution), `ModelResponse.usage` + `model` plumbed
  through `Agent`, `AgentResult.metrics` populated,
  `costReasonableForWorkRule` wired (pass under $1 budget,
  fail over, abstain at zero). 18 new tests. Plan updates
  deferred to this F7.2 commit.
- **2026-08-18 (F7.2)**: HTTP client abstraction
  (`FetchHttpClient` + `FakeHttpClient`) and `OpenAIAdapter`
  landed in `src/llm/`. 58 new tests. **Self-review
  caught three real bugs in the previously-unreviewed
  source files**: (1) `zodToJsonSchema` enum was reading
  `def.value` (zod v3 stores values in `def.values`),
  (2) `zodToJsonSchema` array was reading `def.innerType`
  (zod v3 stores element in `def.type`), (3) `OpenAIAdapter`
  constructor used a lazy `require()` factory that didn't
  satisfy `HttpClient` (the anonymous class had no `request`
  method) — replaced with `new FetchHttpClient()`. The
  array + enum bugs would have lurked until a tool used
  `z.array(...)` or `z.enum(...)`. Updated §2 (status +
  test count), §3 (done work for F7.1 + F7.2), §5 (risk
  5.7 reframed: OpenAI done, Anthropic + DeepSeek next),
  §6.2 (F7.1 + F7.2 marked ✅), §7 (Phase 2 status), §10
  (this entry). Next: F7.3 (Anthropic).
- **2026-08-18 (F7.3)**: `AnthropicAdapter` landed in
  `src/llm/anthropic.ts`. 45 new tests covering
  split/format helpers, request shape, response parsing,
  error handling, all four stop-reason mappings, and a
  full harness-transcript translation. Reuses
  `zodToJsonSchema` + `FetchHttpClient` from F7.2. The
  adapter handles 5 hard requirements (always-set
  `max_tokens` + `anthropic-version`, empty-assistant
  placeholder, missing-usage, empty-response). Updated
  §2 (status), §3 (F7.3 done work), §5.7 (Anthropic done,
  DeepSeek next), §6.2 (F7.3 ✅, F7.4 next), §7 (Phase 2
  status), §10 (this entry). Next: F7.4 (DeepSeek).
- **2026-08-18 (F7.4)**: `DeepSeekAdapter` landed in
  `src/llm/deepseek.ts`. 9 new tests covering defaults,
  overrides (model, baseUrl, auth header), and
  end-to-end response parsing. Thin constructor wrapper
  that subclasses `OpenAIAdapter` (DeepSeek's API is
  OpenAI-compatible, so the entire wire format
  implementation is reused). Updated §2, §3, §5.7
  (DeepSeek done; F7.5 next), §6.2, §7, §10. Next:
  F7.5 (CLI provider dispatch + `--max-cost-usd`).
- **2026-08-18 (F7.5)**: CLI provider dispatch + cost
  cap landed. 28 new tests. `createProviderAdapter` in
  `src/llm/index.ts` resolves `--provider` + env vars
  to the right adapter (4 providers supported; ollama
  is keyless via OpenAI-compatible endpoint). `AgentOptions.maxCostUsd`
  enforced during the run (after every usage
  attribution, not at the end). Both `runAgent` and
  `runSelfEvolve` now accept `--provider` end-to-end.
  Bin script smoke verified: `env -u OPENAI_API_KEY pnpm
  run envoy --provider openai 'hi'` exits 64 with
  helpful error. **Phase 2 milestone per design §22 is
  now "F7 done" — 5 of 5 sub-chunks.** Updated §2
  (status), §3 (F7.5 done work + self-review notes), §5.7
  (mark done), §6.2 (F7.5 ✅; F8 next per design), §7
  (Phase 2 milestone: F7 done), §10 (this entry). Next:
  F8 (envoy-harness-adapter, Package 3) — the MAP
  integration.
- **2026-08-18 (F8.0 + phase 2 review)**: Phase 2
  review fixes (header + status line + new risk 5.11
  for `--max-cost-usd` silent no-op when adapter omits
  `response.model`) + F8 plan + monorepo restructure.
  Single-package repo → pnpm workspace with two
  packages: `packages/envoy-harness/` (Package 1) +
  `packages/envoy-harness-adapter/` (Package 3).
  Workspace root files: `pnpm-workspace.yaml`,
  `tsconfig.base.json`, root `package.json` (private).
  CI: `pnpm -r run typecheck/test/build`. Per-package
  tsconfig extends base. The new adapter package
  depends on `link:` paths to the EnvoyMesh sibling
  monorepo (`@envoymesh/agent-adapter`,
  `@envoymesh/protocol`, `@envoymesh/identity`).
  All 488 + 2 tests pass.
- **2026-08-18 (F8.1)**: `ENVOY_HARNESS_SKILLS` catalog
  + skill → tool-set mapping. 5 skills
  (code-edit, code-review, doc-search, bash-run, plan)
  with cost ceilings from design §11
  ($5/$3/$1/$0.50/$1). `getToolsForSkill(skillId)`
  returns the local tool subset; `isReadOnlySkill()` for
  permission-mode decisions. 19 new tests.
- **2026-08-18 (F8.3)**: Local ↔ wire type translation.
  Lossy in one direction (local → wire): the wire
  `AgentResult` drops the harness transcript, the
  tool-call sequencing, and the effective sandbox
  policy. Full local result is preserved in
  `AgentResult.raw` (lossless audit; the signature
  covers it). Tool calls + tool results are encoded
  as wire `kind: "structured"` blocks with stable
  schemaRefs (`envoymesh://tool-call/v1`,
  `envoymesh://tool-result/v1`). 17 new tests.
- **2026-08-18 (F8.2 + F8.4 + F8.5 + F8.6)**:
  `EnvoyHarnessAdapter` class. Implements
  `AgentAdapter` from `@envoymesh/agent-adapter`. DI
  pattern (per `OpenClawAdapter`): `buildAgent`
  factory + `signResult` closure + `workerPeerId` +
  optional `runtimeVersion` + optional `buildPrompt`.
  Methods: `describeSkills`, `buildManifest` (unsigned;
  orchestrator signs with owner key), `execute`
  (builds local Agent, runs skill, translates +
  signs; respects `signal` and `costCeilingUsd`),
  `verify` (first-cut deterministic placeholder).
  `defaultBuildAgentFactory({ model, cwd? })` exported
  helper. 14 new tests. **Phase 2 milestone per
  design §22 is now "F8 done" — Phase 2 fully
  complete.** Updated §2 (status + 540 tests + 2
  packages), §3 (F8 done work + 3 known limitations),
  §6.3 (F8.0-F8.7 all ✅), §7 (Phase 2: ✅ done,
  540 tests), §10 (this entry). Next: future
  chunks are Phase 4 (LSP, team, cron, trace UI,
  per-call approval, cross-agent verification); no
  more in Phase 2.
- **2026-08-18 (F8 polish + F9.1)**: A (F8 polish) +
  C (plan Phase 4) + B (F9.1 per-call approval) +
  D (deferred to next session). A: real Ed25519 via
  `defaultSignResult` (F8.4+) + the local verifier
  rules wired into `verify()` (F8.6+). C: §6.5
  added with F9.1-F9.5 sub-chunk breakdown. B: F9.1
  — per-call approval callback (Penguin style).
  New `ask` HookDecision variant + AskDecision /
  AskRequest / AskHandler types. `AgentOptions.askHandler`
  — handler returns allow/deny/modify; on `modify`
  the args are re-validated against the tool's zod
  schema; no handler → defaults to deny (safe). CLI
  fallback `defaultAskHandler` writes a one-line
  "ask" record to stderr + deny. **Self-review fix
  caught by tests:** the hook registry's `fire()`
  function only handled `block`/`modify`/`add-context`,
  so the new `ask` decision silently fell through
  to `continue` — the handler was never called.
  Fixed by adding explicit `ask` handling in fire().
  10 new tests in `test/per-call-approval.test.ts`.
  Total: 564 tests across 28 files (498 harness +
  66 adapter). F8 known limitations are now fully
  resolved (signResult is real Ed25519; verify() is
  the local verifier); only the link: dep on the
  EnvoyMesh sibling monorepo remains as a v0
  cross-repo limitation. Updated §2 (status),
  §3 (F9.1 done work), §6.5 (F9.1 ✅), §7 (Phase 4
  in progress), §10 (this entry). Next: F9.2
  (LSP) or F9.4 (--json trace mode), user's pick.
  D: wiring the adapter into EnvoyMesh's
  `runtime-registry` is deferred to the next
  session.
- **2026-08-18 (F9.2 / F9.3 / F9.4 / F9.5)**: Phase 4
  completed. F9.2 (LSP) — `LspClient` interface +
  `NoopLspClient` / `MockLspClient` / `StaticLspManager` /
  `StdioLspClient` (real JSON-RPC over stdio, Content-Length
  framing); `makeLspTools(manager)` returns 4 tools
  (`lsp_definition` / `lsp_references` / `lsp_hover` /
  `lsp_diagnostics`); `AgentOptions.lspManager` auto-registers.
  F9.3 (team + cron) — `TeamConfig` / `AgentSpec` /
  `ScheduleSpec` / `TeamResult`; hand-rolled minimal TOML
  reader (no `@iarna/toml`); `Team.runOnce` with topological
  sort (Kahn's algorithm); `envoy team <config.toml>` CLI
  subcommand. F9.4 (--json trace) — `TraceEvent` union
  (6 kinds: `agent_start` / `model_response` / `tool_call` /
  `tool_result` / `agent_end` / `error`); `NullTracer` /
  `JsonLinesTracer` (`WritableStream` structural type);
  CLI `--json` flag wires `JsonLinesTracer(stdout)`.
  F9.5 (cross-agent verification) — `CrossVerifyFn` type
  + `defaultCrossVerify(otherAdapter)` factory;
  `EnvoyHarnessAdapter.crossVerifyWith` integration
  (`verify()` concatenates local + cross verdicts). All 5
  Phase 4 sub-chunks now done. 130 new tests across 9
  files. Total: 694 tests across 33 files (envoy-harness) +
  82 in envoy-harness-adapter = 776 across 42 files.
  Self-review highlights: (1) `HookRegistry.fire()` had
  to learn the new `ask` decision (F9.1), (2) `StdioLspClient`
  had 3 close-time bugs (close `set too early blocking
  shutdown response, data listener removed before response
  arrives, `diagnostics()` missing `assertOpen`), (3) agent's
  `run()` catches model errors and returns `stopReason:
  "aborted"`, so Team's per-agent failure detection needed
  to check stopReason not exceptions, (4) `instanceof
  TomlParseError` failed across module boundaries; switched
  to `.name === "TomlParseError"` check, (5) cross-verify
  test design called verify on cross-equipped adapter BEFORE
  checking baseline; separated baseline + cross-equipped
  adapters. Updated §1, §2, §3, §6.5, §7, §10. Next: F10
  (Phase 5: mesh-native sub-agents).
- **2026-08-18 (F10.1)**: Phase 5 first sub-chunk landed
  (mesh-native sub-agents). The `task` tool + `MeshSubmitter`
  seam + `LocalMeshSubmitter` default. 4 sub-chunks:
  F10.1.1 (types + `NoopMeshSubmitter`),
  F10.1.2 (`LocalMeshSubmitter` + `defaultBuildSubagentFactory` —
  NEW session per call: own id, own AGENTS.md, own hooks,
  own permission; sub-agent's own permission, not the
  requester's),
  F10.1.3 (`makeTaskTool(submitter)` + `AgentOptions.meshSubmitter`
  auto-registration),
  F10.1.4 (end-to-end via real `Agent.run()`).
  41 new tests across 4 files
  (`test/subagent-types.test.ts` 9,
  `test/subagent-local.test.ts` 12,
  `test/subagent-tool.test.ts` 14,
  `test/subagent-e2e.test.ts` 6).
  Self-review caught 4 real bugs across the 4 sub-chunks:
  (1) parent.abort() test used model returning end_turn on
  call 1, ending the loop before the abort could be detected;
  (2) tests used `require("@envoymesh/envoy-harness")` which
  fails in ESM context — switched to static import;
  (3) redundant first `execute()` call in propagates-submitter-errors
  test threw uncaught; (4) parent and sub-agent shared scripted
  model, sub-agent consumed parent's second response. v0
  limits: local execution only, unsigned result, no cross-node
  routing. Forward-compat seam: `MeshSubmitter` interface
  supports future `RemoteMeshSubmitter`. **F10.1 ✅ done.**
  Total: 656 tests across 36 files (envoy-harness) +
  82 in envoy-harness-adapter = 738 across 45 files.
  Updated §1, §2, §3, §7, §10. **Note:** §6.6 was referenced
  but missing — added in the F10.2 commit. Next: F10.2
  (parallel sub-agents + maxSubagents cap).
- **2026-08-18 (F10.2)**: Phase 5 second sub-chunk landed
  (parallel sub-agent fan-out + `maxSubagents` cap). 1 sub-chunk
  (F10.2.1): `AgentOptions.maxSubagents?: number` (default 8),
  `executeToolCalls` helper auto-detects "all task calls" →
  `Promise.all`; mixed iterations stay serial (bash is
  order-dependent); refuses ALL when `calls.length > maxSubagents`
  (teaches the model to budget; partial runs would hide the
  constraint). Each `tool_result` carries the right `toolCallId`
  (model matches by id, the standard tool-use convention).
  8 new tests in `test/subagent-parallel.test.ts` covering
  parallel detection, single-task fallback, mixed serial,
  cap refusal (3 cases), toolCallId correlation, parent abort.
  **Self-review caught 1 environmental issue:** `dist/agent.js`
  was stale (built at 23:30, src edited at 23:43) — first
  test run reported `maxInFlight=1` (serial execution). After
  `pnpm -F @envoymesh/envoy-harness run build`, the parallel
  path worked correctly (`maxInFlight=3`). **Lesson:** any
  time src changes, rebuild before running tests; otherwise
  tests run against stale compiled output. **F10.2 ✅ done.**
  Total: 664 tests across 37 files (envoy-harness, +8 from
  F10.2.1) + 82 in envoy-harness-adapter = 746 across 45
  files (monorepo). Updated §1 (status line), §2 (status table
  Phase 5 row), §3 (F10.2 done entry), §6.6 (F10 row, F10.2 ✅),
  §7 (template preserved), §10 (this entry). Next: F10.3
  (cross-node `RemoteMeshSubmitter` + Ed25519 signature) or
  push all 8 unpushed commits, user's pick.
- **2026-08-19 (F10.3.1)**: Cross-node trust primitive.
  New `SubagentResultSigner` type in Package 1
  (`src/subagent/signer.ts`):
  `(result: SubagentResult) => string` — a closure
  that takes a result and returns a signature. The
  host injects the key + the algorithm; envoy-harness
  doesn't know about Ed25519, secp256k1, HMAC, etc.
  `LocalMeshSubmitter.signer` is OPTIONAL; v0 default
  (no signer) keeps F10.1.2's empty-signature behavior.
  When provided, the result is signed before returning
  (signer sees the same `SubagentResult` shape the
  parent will see, minus the `signature` field). The
  `synthesizeSubagentResult` helper was promoted from a
  free function to a private method on
  `LocalMeshSubmitter` so it can access `this.signer`.
  7 new tests in `test/subagent-signer.test.ts`
  covering: no-signer (backward compat), signer
  called, exact-once, full-result-payload,
  multi-sub-agent distinct signatures, no-other-field-changes,
  end-to-end tool_result. **Self-review caught 3
  issues:** (1) stale dist (F10.2.1 lesson repeated —
  rebuild before typecheck), (2) top-level
  `src/index.ts` re-export was missing (only
  `src/subagent/index.ts` had it), (3) shared scripted
  model in test #6 caused second submitter to see
  "responses exhausted" (F10.2.1 lesson repeated —
  shared scripted model + two callers needs N
  responses). **F10.3.1 ✅ done.** Total: 671 tests
  across 38 files (envoy-harness) + 82 in
  envoy-harness-adapter = 753 across 47 files
  (monorepo). Updated §1, §2, §3, §6.6, §7, §10.
  Next: F10.3.2 (cross-node `RemoteMeshSubmitter` in
  Package 3, uses the same signer type for request
  signing + result verification).
- **2026-08-19 (F10.3.2)**: Cross-node `MeshSubmitter`
  shipped. `RemoteMeshSubmitter` lives in Package 3
  (`envoy-harness-adapter`) per the boundary doc —
  it's the ONLY place that knows about both
  envoy-harness and the mesh. **Design: thin
  wrapper** over an injected
  `RemoteSubmitterTransport`. The host injects the
  transport; the submitter is a 1-line wrapper that
  forwards `submit()` → `transport.send()`. The
  transport does ALL the work (libp2p, wire format,
  parent request signing, worker result
  verification). envoy-harness-adapter doesn't ship
  a default transport — same DI pattern as F8's
  `defaultSignResult`. **Why opaque (returns
  `SubagentResult`, not `SignedSubagentResult`):**
  the worker signs the result before returning; the
  signature lives in `result.signature` (existing
  field). The transport verifies; the submitter
  just returns. No re-verification at the submitter
  layer. The F10.3.1 plan's `workerPublicKey` +
  `parentPrivateKey` fields on the submitter were
  deferred to the transport's contract (cleaner seam;
  the adapter doesn't need to know about keys).
  Type changes (Package 3): `RemoteSubmitterTransport`
  interface, `RemoteMeshSubmitterOptions`,
  `RemoteMeshSubmitter` class implementing
  `MeshSubmitter`. `src/index.ts` re-exports. 10
  new tests in
  `test/remote-mesh-submitter.test.ts` covering:
  happy path, input forwarding, targetPeerId
  forwarding, abort signal forwarding, error
  propagation, type-level `MeshSubmitter`
  assignment, multi-peer routing, sequential +
  parallel submits (5 in <80ms vs 100ms sequential;
  F10.2 fan-out path works for cross-node too),
  signature preservation. **No self-review issues**
  this time (smaller surface, cleaner design —
  pushing complexity into the transport). **F10.3.2
  ✅ done.** Total: 671 tests across 38 files
  (envoy-harness) + 92 in envoy-harness-adapter =
  763 across 48 files (monorepo). Updated §1, §2,
  §3, §6.6, §7, §10. Next: F10.3.3 (federated
  routing seam: `routingHint` field on
  `SubagentInput` + design doc note) or push 1
  unpushed commit, user's pick.
- **2026-08-19 (F10.3.3)**: Federated routing seam
  + design doc note. The actual routing decision
  (which peer, capability matching, load balancing)
  lives in EnvoyMesh — NOT in envoy-harness. Per the
  boundary doc, envoy-harness's contribution is the
  SEAM: structured advisory fields the host (or a
  future `FanOutSpec`, F10.4+) can set. Type changes
  (Package 1): new `RoutingHint` interface
  (`workerCapabilityTag`, `maxHops?`, `preferredRegions?`);
  `SubagentInput.routingHint?: RoutingHint` (additive
  — existing callers unchanged); `task` tool's zod
  schema does NOT expose `routingHint` to the model
  (host-only). Design doc: `boundary.en.md` gains a
  new "Federated routing: the seam" section with
  the explicit note **"Routing is a mesh concern;
  envoy-harness exposes the hint, EnvoyMesh decides
  the target."** The routing table row updated. 4
  new tests in `test/subagent-routing-hint.test.ts`:
  routingHint accepted (additive), forwarded through
  MeshSubmitter, NOT in model's zod schema, doc test
  asserts the seam note is in `boundary.en.md`.
  **Self-review caught 1 issue:** first test design
  tried to import `TaskInputSchema` via
  `'@envoymesh/envoy-harness/dist/subagent/tools.js'`
  (self-package can't import its own dist via the
  package alias); fixed by importing from the
  package root. **F10.3.3 ✅ done. Phase 5 status:**
  F10.1, F10.2, F10.3.1, F10.3.2, F10.3.3 — all done.
  Mesh-native sub-agent path is complete (parent →
  task tool → MeshSubmitter → local/remote → signed
  result → federated routing hint). F10.4+ is next:
  `FanOutSpec` (capability-driven fan-out), cost
  aggregation, progress streaming. Total: 675 tests
  across 39 files (envoy-harness) + 92 in
  envoy-harness-adapter = 767 across 49 files
  (monorepo). Updated §1, §2, §3, §6.6 (F10.3 row
  all 3 sub-chunks ✅), §7, §10. Next: F10.4 or
  push 1 unpushed commit, user's pick.

---

### F9.2 — LSP client + 4 tools (3 sub-chunks)
**Phase 4 second sub-chunk.** F9.2 brings IDE-grade
navigation tools to the agent (go-to-definition,
find-references, hover, diagnostics) by wrapping
the LSP protocol.

**F9.2.1 (this commit) — types + tests + default impl +
mock** lands the type surface (LspClient, LspManager,
LspLocation, LspHover, LspDiagnostic) plus 3
implementations: `NoopLspClient` (default; returns
empty), `MockLspClient` (scriptable; for tests),
`StaticLspManager` (extension-based routing with
literal-path overrides; production wiring). 21 new
tests in `test/lsp.test.ts`.

**F9.2.2 (this commit) — `StdioLspClient`** is the
production `LspClient`. Speaks JSON-RPC 2.0 with
`Content-Length` framing over a child process. Implements
the `initialize` handshake, the 4 ops, the
`textDocument/publishDiagnostics` notification dispatch
(server-push), server-initiated request handling (replies
with `null` in v0), and graceful `shutdown` / `exit` on
close. Also lands `FakeStdio` (scriptable stdio pair) +
`frameLspMessage` for testing without a real server. 30
new tests in `test/lsp-stdio.test.ts`. **Self-review
caught 3 real bugs:** (1) `_closed` set before
`sendRequest('shutdown')` → `assertOpen` throws;
(2) data listener removed before shutdown response
arrives → close() hangs; (3) `diagnostics()` only
checks `assertInitialized`, not `assertOpen` → calls
after close() silently return [].

**F9.2.3 (this commit) — 4 tools + AgentOptions
integration.** Lands `makeLspTools(manager)` returning
4 tools (`lsp_definition`, `lsp_references`,
`lsp_hover`, `lsp_diagnostics`). Each tool looks up
the client via `manager.forFile(file)`, returns
`{ content, isError: true }` on "no client" or
client errors. `AgentOptions.lspManager?` is the
new optional field; when provided, the 4 tools are
auto-registered with the tool registry in the Agent
constructor. The agent does NOT close the manager
(host owns lifecycle). 13 new tests in
`test/lsp-tools.test.ts`.

**Total: 562 tests across 29 files.** F9.2 is
**done**; the agent now has 4 IDE-grade navigation
tools when a host provides an `LspManager`. Auto-spawn
of language servers (the actual `typescript-language-server`
etc.) is F9.2+1 — deferred. Updated §2 (status), §3
(this entry), §6.5 (F9.2 ✅), §7 (sub-chunk template
preserved), §10 (this entry). **Next: F9.4 (--json
trace mode) or F9.3 (team+cron), user's pick.**

---

### F9.4 — `--json` trace mode (3 sub-chunks)
**Phase 4 third sub-chunk.** Debugging agent runs
is the most common production need. v0 ships the
JSON Lines trace layer; a downstream viewer (a
separate repo) consumes the stream.

**F9.4.1 (this commit) — types + NullTracer +
JsonLinesTracer.** Lands the `TraceEvent` union
(6 kinds: `agent_start`, `model_response`,
`tool_call`, `tool_result`, `agent_end`, `error`),
the `Tracer` interface, and the two no-op /
write-to-stream implementations. Each event carries
an ISO 8601 `ts`. `JsonLinesTracer` catches write
errors silently (the agent's run shouldn't fail
because the trace stream is dead); `droppedEvents`
counter for diagnostics. 8 new tests in
`test/trace.test.ts`.

**F9.4.2 (this commit) — AgentOptions.tracer +
5 emit points.** Lands the agent integration. The
agent calls `tracer.emit(...)` at 5 points: top of
`run()` (agent_start), after each model call
(model_response), before/after each tool
(tool_call / tool_result), and at `makeResult()`
(agent_end). `agent_end` is the LAST event. Errors
have a separate `error` event. Adds a public
`currentModel` getter on `CostTracker` for the
agent_start model name. 10 new tests in
`test/trace-agent.test.ts`. **Self-review caught 3
real bugs:** (1) `currentModel()` didn't exist on
CostTracker (added public getter); (2) test designed
for 2 model calls but used text-only responses that
the agent ended on after 1; (3) tool_call event
includes the `type: "tool_call"` ContentBlock tag
(test was missing it).

**F9.4.3 (this commit) — CLI `--json` integration.**
Wires the `--json` flag (already accepted, previously
ignored) to a `JsonLinesTracer` writing to stdout.
`--json` + `--quiet` is supported (just trace
events, no human output). Default mode interleaves
both. `RunOptions.tracer?` allows programmatic
injection. 4 new tests in `test/cli.test.ts`.
**Self-review caught 2 real bugs:** (1) `tool_call`
+ `tool_result` were ONLY emitted on the success
path; an unknown tool or invalid args would skip
the emit (the trace didn't see the failure). Fixed
by emitting on every path. (2) The "should-not-appear"
test was checking `out.data` for absence, but the
text legitimately appears in the model_response
event's `content` field. Fixed by checking the last
line is `agent_end` (no trailing human output).

**Total: 584 tests across 30 files.** F9.4 is
**done**; the bin script has working `--json` trace
mode. The web UI for trace rendering is downstream
(a separate repo). Updated §2 (status), §3 (this
entry), §6.5 (F9.4 ✅), §7 (sub-chunk template
preserved), §10 (this entry). **Next: F9.3
(team+cron) or F9.5 (cross-verify), user's pick.**

---

### F9.3 — Team + cron (3 sub-chunks)
**Phase 4 fourth sub-chunk.** Multi-agent workflows
land as a TOML config + an in-process runner.
The host (system cron, k8s) calls `runOnce()` on
schedule; v0 has no actual cron daemon.

**F9.3.1 (this commit) — types + minimal TOML
reader.** Lands `TeamConfig` (name + agents[] +
optional schedule), `AgentSpec` (id, role,
systemPrompt, objective, dependsOn),
`ScheduleSpec` (5-field cron), `TeamResult`,
`AgentRunResult`. Hand-rolled minimal TOML reader
in `parseTeamToml` (~250 lines) supporting the v0
subset: top-level `key = "string"`, `[section]`,
`[[agents]]` (array of tables), string arrays,
comments, blank lines, basic string escapes. Throws
`TomlParseError` on bad input with line number +
line content. 17 new tests in `test/team-toml.test.ts`.

**F9.3.2 (this commit) — `Team.runOnce()` with
topological order.** Lands the `Team` class
(`runOnce()`). Kahn's algorithm for topological
sort on `dependsOn`. Each agent runs in
topological order; the downstream agent's prompt
includes the upstream agents' final text as
"context from upstream agents". `${input}` is
substituted in each agent's objective with the
team-level input. Per-agent failure (model error,
etc.) sets `TeamResult.status: "failed"` with an
error message. Throws on missing dependency or
cycle. 9 new tests in `test/team-runner.test.ts`.
**Self-review caught 1 real bug:** the agent's
`run()` catches model errors and returns a
synthetic `aborted` result rather than throwing;
the Team's `runOnce` only checked for exceptions,
so the team thought an aborted agent was
successful. Fix: `runAgent` now returns
`{text, stopReason}`; `runOnce` checks
`stopReason === "aborted"` and treats it as a
per-agent failure.

**F9.3.3 (this commit) — CLI `team` subcommand.**
Wires `envoy team <config.toml>` into argv +
runner. New flags: `--model`, `--provider`,
`--cwd`, `--input`, `--json`, `--quiet`. The
runner reads the TOML, builds a `Team`, calls
`runOnce()`, prints a per-agent summary. The
`--json` flag works with team too (per-agent
trace events stream to stdout). 3 new tests in
`test/cli.test.ts`. **Self-review caught 2 real
bugs:** (1) `TomlParseError` instanceof check
failed because the test imports from the built
`dist/` (different class identity than source).
Fix: use `.name === "TomlParseError"` instead
of `instanceof`. (2) The `toTeamConfig` +
`toAgentSpec` error paths threw plain `Error`
(not `TomlParseError`), so the CLI's name-based
detection still missed them. Fix: all error
throws in `toml.ts` use `TomlParseError`. The
class is the public error type; the CLI relies
on its `.name`.

**Total: 612 tests across 32 files.** F9.3 is
**done**; the bin script supports `envoy team
<config.toml>` (alongside the default `envoy
<prompt>` and `envoy self-evolve`). The host
calls the subcommand on a schedule. Real cron
daemon and parallel agent execution are out of
scope for v0. Updated §2 (status), §3 (this
entry), §6.5 (F9.3 ✅), §7 (sub-chunk template
preserved), §10 (this entry). **Next: F9.5
(cross-verify), user's pick.**

---

### F9.5 — Cross-agent verification (2 sub-chunks)
**Phase 4 final sub-chunk.** The orchestrator can
get a second opinion on a worker's result by
re-running the same skill on a different
`AgentAdapter` (typically a different model).
The local + cross verdicts are concatenated; the
orchestrator collapses with `combineVerdicts`.

**F9.5.1 (this commit) — `CrossVerifyFn` type +
`defaultCrossVerify` factory.** The factory re-runs
the same skill on the other adapter with v0
limits: `inputArtifacts: []`, `costCeilingUsd: 0`,
`deadlineMs: 30_000`. On the new result, runs
`runLocalVerifier` and returns the verdicts. If
the other adapter throws, returns a single
`disputed` verdict with the error in `signals`.
4 new tests in `test/cross-verify.test.ts`.
**Self-review caught 1 real issue:** the agent's
`run()` catches model errors and returns a
synthetic `aborted` result rather than throwing.
A test that used a throwing model thought it
exercised the disputed path, but the agent caught
it. Fix: wrap `execute()` directly to throw
(simulates a transport-level failure the agent's
catch can't swallow).

**F9.5.2 (this commit) — `EnvoyHarnessAdapter
.crossVerifyWith` integration.** The adapter's
`verify()` runs the local verifier + (when set)
the cross-verify closure, and returns the
concatenated `Verdict[]`. The orchestrator
collapses with `combineVerdicts()`. Without
`crossVerifyWith`, `verify()` is unchanged.
5 new tests in `test/cross-verify-adapter.test.ts`.

**Total: 694 tests across 33 files.** F9.5 is
**done**; cross-agent verification is wired.
The 5 Phase 4 sub-chunks are now ALL done
(F9.1, F9.2, F9.3, F9.4, F9.5). Phase 4 is
complete. Updated §2 (status), §3 (this entry),
§6.5 (F9.5 ✅), §7 (sub-chunk template preserved),
§10 (this entry). **Next: integration + push
all 25+ unpushed commits, user's pick.**

---

---

### F10.1 — Mesh-native sub-agents (4 sub-chunks)
**Phase 5 first sub-chunk.** The "real workable"
sub-agent. The parent calls the `task` tool;
the tool submits to a `MeshSubmitter`; the
submitter runs the sub-agent in a NEW local
session.

**F10.1.1 (this commit) — types + `NoopMeshSubmitter`.**
Lands `SubagentInput`, `SubagentResult`,
`MeshSubmitter` interface, and a no-op submitter
that throws the documented error message. The
default-when-undefined is "no submitter" (so
no `task` tool is registered); the no-op
submitter exists for tests + forward-compat.
9 new tests in `test/subagent-types.test.ts`.
Also: re-exported `Verdict` from `verifier/index.ts`
(was unexported — needed by `SubagentResult.verdict`).

**F10.1.2 (this commit) — `LocalMeshSubmitter` +
`defaultBuildSubagentFactory`.** The default
plumbing: the host injects a `buildSubagent`
factory; the submitter calls it, runs the
resulting `Agent`, synthesizes a `SubagentResult`.
The default factory creates a NEW `InMemorySession`
per call (own id, own AGENTS.md, own hooks) with
the configured model + `BUILTIN_TOOLS` + `read-only`
permission. The sub-agent's own policy, not the
requester's. Parent's `signal` is forwarded to
the new agent's abort (next iteration boundary).
12 new tests in `test/subagent-local.test.ts`.
**Self-review caught 2 real issues:**
(1) The "parent.abort()" test was wrong: the model
returned `end_turn` on the first call, so the
agent's loop ended before the abort could be
detected. Fix: model returns a `tool_call` on
every call so the loop iterates; the abort fires
on call #4; the loop's next iteration check sees
the abort.
(2) Two tests used `require("@envoymesh/envoy-harness")`
which fails in ESM context. Fix: static import
of `ToolRegistry` at the top of the test file.

**F10.1.3 (this commit) — `task` tool +
`AgentOptions.meshSubmitter`.** The parent's
escape hatch. `makeTaskTool(submitter)` returns
a `Tool` named `task` with the documented zod
schema (`objective`, `capability_tag`,
`cost_ceiling_usd`, `deadline_ms`, optional
`preferred_peer_id` / `preferred_runtime`).
`AgentOptions.meshSubmitter?` is the new opt-in
field; when set, the `task` tool is auto-registered
with the parent's tool registry. No submitter →
no `task` tool. 14 new tests in
`test/subagent-tool.test.ts`.
**Self-review caught 1 real issue:** the
"propagates submitter errors" test had a
redundant first `execute()` call that threw
(`NoopMeshSubmitter` throws); the test's
asserts on the SECOND call expected the throw.
The first call wasn't caught. Fix: removed
the first call; the test now just checks the
one `execute()` throws as expected.

**F10.1.4 (this commit) — end-to-end via real
`Agent.run()`.** Lands 6 end-to-end tests:
- The parent's tool list includes `task`
  when `meshSubmitter` is set.
- The full happy path: parent emits `task` call →
  sub-agent runs in a new session → result
  returns to the parent → parent's final
  answer references the sub-agent's text.
- The sub-agent's session is independent of
  the parent's (capabilityTag routes through
  the factory).
- The parent's metrics are not affected by
  the sub-agent's cost (separate `CostTracker`s).
- The default `buildSubagent` factory is used
  when no factory is provided.
- The factory receives a fresh input on each
  call (the two-call pattern).

**Total: 656 tests across 36 files.** F10.1 is
**done**; the "real workable" sub-agent is shipped.
The parent agent can call the `task` tool to spawn
a sub-agent that runs in a NEW local session (own
id, own AGENTS.md, own hooks, own permission). The
`MeshSubmitter` seam supports a future
`RemoteMeshSubmitter` for cross-node execution;
v0 ships `LocalMeshSubmitter` as the default.
Updated §2 (status), §3 (this entry), §6.6
(F10.1 ✅), §7 (sub-chunk template preserved),
§10 (this entry). **Next: F10.2+ (cross-node
submitter, signature, federated routing) or
Phase 5 second sub-chunk, user's pick.**

---

### F10.2 — Parallel sub-agents + maxSubagents cap (1 sub-chunk)
**Phase 5 second sub-chunk.** v0 (F10.1) executes
`task` tool calls sequentially (`for await`).
When the model emits 3 `task` calls in one response
("spawn 3 reviewers"), they run one after the other.
That's the right default for **most** tools
(`bash` is order-dependent: `git add` then `git
commit`), but `task` is **inherently parallel** — each
sub-agent runs in its own session with no shared state.

**v0 scope (this chunk):**

1. **Auto-detect "all N tool calls are `task`"** →
   run them in parallel via `Promise.all`. The
   detection: every call in the iteration is `name ===
   "task"`. Mixed iterations (some `task` + some
   `bash`) stay serial (the bash side is order-dependent).
   The model is the driver; the host doesn't opt in.

2. **`AgentOptions.maxSubagents?: number`** — a
   hard cap on the number of `task` calls per
   turn. Default: `8`. When the model emits more
   than `maxSubagents` `task` calls in one turn,
   the agent **refuses all of them** and returns
   one `isError: true` tool_result per refused
   call with the message `"maxSubagents reached:
   N (cap is M)"`. **Why refuse all, not partial:**
   partial runs would hide the constraint from
   the model; refusing all teaches the model to
   budget its sub-agents.

3. **Abort propagation** — already wired in F10.1.2
   (LocalMeshSubmitter wires the parent's signal
   to the sub-agent's abort). With parallel,
   `Promise.all` honors the same signal: every
   in-flight sub-agent aborts on the next iteration
   boundary when the parent aborts.

4. **Cost tracking** — sub-agents keep their own
   `CostTracker`s (F10.1.2). The parent's
   `maxCostUsd` cap is unchanged (it's a
   per-Agent cap, only the parent's model calls).
   **Future:** F10.3+ will aggregate sub-agent
   costs into the parent's `CostTracker` (a
   "this sub-agent's cost is the parent's cost"
   attribution). v0: the host budgets sub-agents
   separately via each `task` call's
   `cost_ceiling_usd`.

5. **Result shape** — N tool_results, one per
   sub-agent. Each tool_result carries the
   `SubagentResult` for that call. The order
   of results in the message block follows the
   completion order of `Promise.all` (not the
   call order). The model matches results to
   calls via `toolCallId` (this is the standard
   OpenAI / Anthropic convention; the LLM knows
   how to handle it).

**Type sketch:**

```ts
// src/agent.ts — AgentOptions
interface AgentOptions {
  // ... existing ...
  /** F10.2: max sub-agents per turn. Default 8.
   *  When the model emits more `task` calls than
   *  this, ALL are refused with isError: true
   *  and a clear message. */
  maxSubagents?: number;
}

// src/agent.ts — tool-execution step
private async executeToolCalls(
  calls: ReadonlyArray<ToolCall>,
): Promise<void> {
  if (calls.length === 0) return;

  // Sub-agent fan-out: if EVERY call is the
  // `task` tool, run them in parallel. The
  // `task` tool's contract is "each call gets
  // its own session" — there's no shared
  // state to order by. Other tools (bash,
  // lsp_definition, etc.) may have order
  // dependencies; they stay serial.
  if (this.meshSubmitter && calls.every(isTaskCall)) {
    // Check the cap.
    const cap = this.maxSubagents ?? DEFAULT_MAX_SUBAGENTS;
    if (calls.length > cap) {
      // Refuse ALL the calls (clear message
      // teaches the model to budget).
      for (const call of calls) {
        this.appendToolResult(
          call.id,
          `maxSubagents reached: ${calls.length} task calls in one turn (cap is ${cap}). Refused.`,
          true,
        );
      }
      return;
    }
    // Parallel run.
    await Promise.all(
      calls.map((call) => this.executeToolCall(call)),
    );
    return;
  }

  // Serial run (existing path).
  for (const call of calls) {
    if (this.abortController.signal.aborted) break;
    await this.executeToolCall(call);
  }
}
```

**Tests (target: ~10-15):**
- N `task` calls in one iteration run in
  parallel (assert on concurrency: the model
  is called once per sub-agent; the sub-agents'
  runs overlap in time).
- Mixed iteration (1 `task` + 1 `bash`) stays
  serial (the `task` runs to completion before
  `bash` starts).
- `maxSubagents: 2` and the model emits 3
  `task` calls → all 3 are refused with
  `isError: true`.
- `maxSubagents: 8` (default) and the model
  emits 8 `task` calls → all 8 run.
- `maxSubagents: 0` and the model emits 1
  `task` call → refused.
- Parent abort during a parallel run → all
  in-flight sub-agents abort.
- The tool_results land in the parent's
  transcript with the right `toolCallId`s.
- Each sub-agent's session is independent
  (already tested in F10.1.4; regression check
  here).
- Single `task` call (the common case) still
  works (the parallel path also handles N=1).

**Out of scope for v0:**
- **Aggregating N results into one tool_result.**
  The standard tool-use pattern (N results,
  one per call) is what the LLM expects; the
  model synthesizes. Aggregation would hide
  the per-sub-agent structure.
- **Capability-driven fan-out (`FanOutSpec`).**
  v0 is model-driven; the host doesn't pre-register
  fan-out patterns. A future F10.3 chunk can add
  `AgentOptions.fanOut: Record<capabilityTag, { count: number; partition: (i, n) => SubagentInput }>`.
- **Cost aggregation into the parent's
  `CostTracker`.** v0: sub-agents have their own
  cost; the host budgets via per-call
  `cost_ceiling_usd`. A future chunk can wire
  the sub-agent's `CostTracker.addUsage` into
  the parent's tracker.

**Sub-chunk breakdown (planned):**
- F10.2.1: parallel detection + maxSubagents +
  tests (single chunk; tightly coupled).

---

### F10.2 — done

**F10.2.1 (this commit) — parallel sub-agent fan-out
+ `maxSubagents` cap.** When the model emits N `task`
tool calls in one iteration, run them in parallel via
`Promise.all`. Mixed iterations (some `task` + some
`bash`) stay serial because `bash` is order-dependent.
Each sub-agent already runs in its own session (F10.1)
so there's nothing to order by.

When the call count exceeds `maxSubagents` (default 8,
host-configurable via `AgentOptions.maxSubagents`),
**ALL calls are refused** with `isError: true` and
a clear message (`"maxSubagents reached: N task calls
in one turn (cap is M). Refused."`). Refusing all (vs
partial) teaches the model to budget sub-agents;
partial runs would hide the constraint.

Sub-agent cost: the parent's `maxCostUsd` is unchanged
(per-Agent, only parent's model calls). Sub-agents keep
their own `CostTracker`s. The host budgets sub-agents
separately via each `task` call's `cost_ceiling_usd`.
Aggregation into the parent's tracker is deferred to
F10.3+.

Result shape: N `tool_result` blocks, one per sub-agent.
The order of results in the message block follows the
completion order of `Promise.all` (not the call order).
The model matches results to calls via `toolCallId` (the
standard tool-use convention; LLMs handle this).

8 new tests in `test/subagent-parallel.test.ts`:
1. 3 `task` calls run with `maxInFlight=3` (truly parallel).
2. A single `task` call still works (the parallel path
   handles N=1).
3. Mixed iteration (`task` + `bash`) stays serial.
4. `maxSubagents: 2` with 3 `task` calls → all 3 refused
   with `isError: true`; sub-agent model never called.
5. `maxSubagents: 0` with 1 `task` call → refused.
6. `maxSubagents: 8` (default) with 8 `task` calls → all 8 run.
7. Each `tool_result` carries the right `toolCallId`
   (order may differ; the model matches by id).
8. Parent `abort()` BEFORE the run → the loop's first
   iteration check sees the abort; `stopReason: "aborted"`.

**Self-review caught 1 environmental issue:** the
`dist/agent.js` was stale (built at 23:30, src edited
at 23:43). The first test run reported `maxInFlight=1`
(serial execution). After `pnpm -F @envoymesh/envoy-harness
run build`, the parallel path worked correctly
(`maxInFlight=3`). **Lesson:** any time src changes,
rebuild before running tests; otherwise tests run against
stale compiled output.

**Total: 664 tests across 37 files** (envoy-harness
Package 1, +8 from F10.2.1; +82 from F9.5/F10.1 cross-verify
work in envoy-harness-adapter Package 3 → monorepo total
**746 across 45 files**). F10.2 is **done**; parallel
sub-agents + cap are shipped. Phase 5 has its first two
sub-chunks landed.

Updated §1 (status line), §2 (status table Phase 5 row),
§3 (this entry), §6.6 (F10 row, F10.2 ✅), §7 (template
preserved), §10 (this entry). **Next: F10.3 (cross-node
`RemoteMeshSubmitter` + Ed25519 signature) or push
all 8 unpushed commits, user's pick.**

---

### F10.3 — Cross-node sub-agents (3 sub-chunks)
**Phase 5 third sub-chunk.** v0 (F10.1 + F10.2) ships
`LocalMeshSubmitter` only — the sub-agent runs in a NEW
local session (own id, own AGENTS.md, own hooks, own
permission). `SubagentResult.signature` is an empty
string. **F10.3 makes sub-agents cross-node**, with
Ed25519 trust on the result.

**The package boundary (per `docs/boundary.{en,zh}.md`):**

envoy-harness (Package 1) is a local runtime with ZERO
EnvoyMesh-internal deps. The actual cross-node transport
(libp2p, mesh envelopes, peer discovery) cannot live in
envoy-harness. The F10.3 split follows the F8 pattern
(`envoy-harness-adapter` is the ONLY place that knows
about both envoy-harness and the mesh):

- **Package 1 (envoy-harness)** owns the **seam**:
  `SubagentResultSigner` type, `RemoteSubmitterTransport`
  interface, `RemoteMeshSubmitterOptions` shape, plus
  the optional `signer` field on `LocalMeshSubmitter`.
- **Package 3 (envoy-harness-adapter)** owns the
  **concrete cross-node impl**: `RemoteMeshSubmitter`
  class that wires the transport + the signer + the
  worker public key + the parent's verify path.
- **EnvoyMesh (sibling monorepo)** owns the **transport
  implementation**: libp2p, peer discovery, capability
  routing, the wire envelope for sub-agent submission.

**v0 (F10.3) scope — three sub-chunks:**

1. **F10.3.1 — `SubagentResultSigner` abstraction in
   Package 1.** A new type: `SubagentResultSigner =
   (result: SubagentResult) => string` (a closure that
   takes a result and returns a signature). Add an
   optional `signer?: SubagentResultSigner` to
   `LocalMeshSubmitter`; when provided, the
   `synthesizeSubagentResult` helper signs the result
   before returning. v0 default: no signer → empty
   signature (backward compatible with F10.1.2). Why
   the seam: the host injects the key + the algorithm;
   envoy-harness doesn't need to know about Ed25519.
   ~6 tests covering signed/unsigned LocalMeshSubmitter
   paths.

2. **F10.3.2 — `RemoteMeshSubmitter` in Package 3
   (envoy-harness-adapter).** A `MeshSubmitter`
   implementation that submits the sub-agent to a
   remote worker node. Constructor: `{ transport:
   RemoteSubmitterTransport, workerPublicKey:
   SubagentVerifierKey, parentPrivateKey:
   SubagentSignerKey, targetPeerId: string }`. On
   `submit()`: serialize the input, send via the
   transport, receive a `SignedSubagentResult` back,
   verify the signature using the worker's public
   key, return the result. **The transport** is an
   interface: `RemoteSubmitterTransport = { send(
   input: SubagentInput, target: string, signal:
   AbortSignal) => Promise<SignedSubagentResult> }`.
   This transport is provided by EnvoyMesh at the
   `EnvoyHarnessAdapter.execute()` boundary (a thin
   method: "submit this to peer X" → "here's the
   signed result"). ~10 tests with a fake transport
   covering happy path, signature mismatch, transport
   timeout, abort propagation.

3. **F10.3.3 — Federated routing seam (Package 1 +
   Package 3).** The actual routing decision (which
   peer to send to, capability matching, load
   balancing) lives in EnvoyMesh. envoy-harness's
   contribution is the **seam**: a `routingHint?:
   { capabilityTag, maxHops?, preferredRegions? }`
   field on `SubagentInput` (additive; the model
   doesn't see it, but a future `FanOutSpec` can
   pre-set it). The `RemoteSubmitterTransport.send`
   signature takes the `targetPeerId` as an explicit
   parameter (the routing decision is OUTSIDE the
   transport). Document the seam in `design.en.md`:
   "Routing is a mesh concern; envoy-harness exposes
   the hint, EnvoyMesh decides the target." ~3
   tests covering the type surface + a doc test
   that asserts the seam comment is present.

**v0 (F10.3) — out of scope:**

- **Federated routing implementation** (capability
  matching, peer scoring, load balancing). Lives in
  EnvoyMesh, not envoy-harness.
- **The actual `RemoteSubmitterTransport` impl**
  (libp2p send/recv). Lives in EnvoyMesh, not
  envoy-harness. envoy-harness-adapter provides the
  seam; EnvoyMesh provides the implementation.
- **Multi-hop routing** (`maxHops > 1`). v0: 1 hop
  (parent → worker). Multi-hop is a future mesh
  feature; envoy-harness's seam supports it
  additively.
- **Streaming progress** for the sub-agent's run.
  v0: fire-and-await. F10.4+ if needed.

**Type sketch (F10.3.1 + F10.3.2):**

```ts
// src/subagent/signer.ts (Package 1)
export type SubagentResultSigner = (
  result: SubagentResult,
) => string;

// src/subagent/types.ts (Package 1) — additive
export interface SubagentInput {
  // ... existing F10.1 fields ...
  /** F10.3.3: routing hint for federated routing.
   *  The mesh decides the target; this is metadata
   *  the mesh can use to make a better decision. */
  routingHint?: {
    capabilityTag: string;
    maxHops?: number;
    preferredRegions?: ReadonlyArray<string>;
  };
}

export interface SignedSubagentResult {
  result: SubagentResult;
  /** Ed25519 signature over the canonical form
   *  of `result` (excluding the signature itself). */
  signature: string;
  /** Public key of the worker that produced the
   *  result. Verifier uses this to check. */
  workerPublicKey: string;
}

// src/subagent/local-mesh-submitter.ts (Package 1)
// — additive
export interface LocalMeshSubmitterOptions {
  // ... existing F10.1.2 options ...
  /** F10.3.1: optional signer. When provided, the
   *  result is signed before returning. v0: leave
   *  undefined → empty signature (no trust needed). */
  signer?: SubagentResultSigner;
}

// packages/envoy-harness-adapter/src/remote-mesh-submitter.ts (Package 3)
export interface RemoteSubmitterTransport {
  send(
    input: SubagentInput,
    targetPeerId: string,
    signal: AbortSignal,
  ): Promise<SignedSubagentResult>;
}

export interface RemoteMeshSubmitterOptions {
  transport: RemoteSubmitterTransport;
  /** The worker's public key. The submitter uses
   *  this to verify the result's signature. */
  workerPublicKey: string;
  /** The parent's signing key. The submitter
   *  signs the request with this; the worker
   *  verifies. */
  parentPrivateKey: string;
  /** The peer to send the sub-agent to. */
  targetPeerId: string;
}

export class RemoteMeshSubmitter implements MeshSubmitter {
  // ... implements the same interface as LocalMeshSubmitter ...
  async submit(input: SubagentInput, signal: AbortSignal): Promise<SubagentResult> {
    const signed = await this.options.transport.send(
      this.signInput(input),
      this.options.targetPeerId,
      signal,
    );
    if (!verify(signed.signature, signed.result, this.options.workerPublicKey)) {
      throw new Error("sub-agent result signature verification failed");
    }
    return signed.result;
  }
}
```

**Why the seam is `RemoteSubmitterTransport`, not a libp2p
class directly:**

The F8 pattern: `EnvoyHarnessAdapter` takes a `buildAgent`
factory + a `signResult` closure. The host injects both;
envoy-harness doesn't know how either is implemented. F10.3
follows the same DI pattern: the host injects a
`RemoteSubmitterTransport` (the thing that knows how to send
a `SubagentInput` to a peer). envoy-harness-adapter's
`RemoteMeshSubmitter` is the standard implementation; EnvoyMesh
provides the real libp2p-backed transport.

**Sub-chunk breakdown (planned):**

- F10.3.1: `SubagentResultSigner` type + `LocalMeshSubmitter.signer` option + ~6 tests (~80 lines).
- F10.3.2: `RemoteMeshSubmitter` in Package 3 + `RemoteSubmitterTransport` interface + ~10 tests (~250 lines).
- F10.3.3: `routingHint` field on `SubagentInput` + design doc note + ~3 tests (~50 lines).

**Total estimated: 3 commits, ~19 tests, ~380 lines across both
packages + ~30 lines in `design.en.md`.**

---

### F10.3.1 — done

**F10.3.1 (this commit) — `SubagentResultSigner` seam in Package 1.**
The cross-node trust primitive. New type:
`SubagentResultSigner = (result: SubagentResult) => string` —
a closure that takes a result and returns a signature string.
The host injects the key + the algorithm; envoy-harness
doesn't know (or care) about Ed25519, secp256k1, HMAC, etc.

`LocalMeshSubmitterOptions.signer?: SubagentResultSigner` is
an OPTIONAL field. v0 default (no signer) keeps the F10.1.2
behavior: empty signature. When provided, the result is
signed before returning.

The `synthesizeSubagentResult` helper was promoted from a
free function to a private method on `LocalMeshSubmitter`
so it can access `this.signer`. The signature replaces the
default empty string after the full result is built (the
signer sees the same `SubagentResult` shape the parent
will see, minus the signature field which is what they're
computing).

`src/index.ts` re-exports `SubagentResultSigner` so the
test file (and the future F10.3.2 `RemoteMeshSubmitter`)
can import it from the package root.

7 new tests in `test/subagent-signer.test.ts`:
1. No signer → empty signature (backward compat).
2. Signer called; `signature === signer(result)`.
3. Signer called exactly once per submit.
4. Signer receives the full `SubagentResult` (status,
   content, verdict, cost, duration, workerPeerId).
5. Two sub-agents in a row → signer called twice;
   distinct signatures (because their content differs).
6. Signing only changes the `signature` field; every
   other field on `SubagentResult` is identical.
7. End-to-end: parent's `tool_result` block carries the
   signed `SubagentResult` (signature visible in the
   parent's transcript).

**Self-review caught 3 issues:**
1. **Stale dist (F10.2.1 lesson repeated).** First
   typecheck run reported `SubagentResultSigner is not
   exported from "@envoymesh/envoy-harness"`. The src
   had the new file + re-export, but the dist was the
   F10.2.1 build. Fix: `pnpm -F @envoymesh/envoy-harness
   run build` before typecheck. **Lesson reinforced:**
   any src change → rebuild before testing. Documented
   in §6.6 (this entry) and reaffirmed in the F10.3.1
   commit message.
2. **Top-level `src/index.ts` re-export was missing.**
   The new type was re-exported from
   `src/subagent/index.ts` but not from
   `src/index.ts` (the package's public entry).
   Test file imports from `"@envoymesh/envoy-harness"`
   → resolves to the package root → didn't find the
   type. Fix: add `type SubagentResultSigner` to the
   `src/index.ts` re-export.
3. **Shared scripted model in test #6 caused the second
   submitter to see "responses exhausted" abort.**
   Same F10.2.1 self-review lesson: shared scripted
   model + two callers → second caller consumes the
   exhausted pool. Fix: scripted model has 2 responses,
   one per submitter. Statuses now match (both
   `completed`) and the assertion passes.

**Total: 671 tests across 38 files** (envoy-harness,
+7 from F10.3.1) + 82 in envoy-harness-adapter =
**753 across 47 files** (monorepo). F10.3.1 is done.
The `SubagentResultSigner` seam is in place; F10.3.2
(`RemoteMeshSubmitter` in Package 3) will use the same
type for request signing + result verification.

Updated §1 (status line), §2 (status table Phase 5
row), §3 (this entry), §6.6 (F10.3 row, F10.3.1 ✅),
§7 (template preserved), §10 (this entry). **Next:
F10.3.2 (cross-node `RemoteMeshSubmitter` +
`RemoteSubmitterTransport` interface in Package 3)
or push 1 unpushed commit, user's pick.**

---

### F10.3.2 — done

**F10.3.2 (this commit) — `RemoteMeshSubmitter` in
Package 3.** The cross-node `MeshSubmitter` lives in
`envoy-harness-adapter` per the boundary doc — it's
the ONLY place that knows about both envoy-harness
and the mesh.

**Design: thin wrapper over an injected transport.**
The host injects a `RemoteSubmitterTransport`; the
submitter is a 1-line wrapper:

```ts
async submit(input, signal) {
  return this.transport.send(input, this.targetPeerId, signal);
}
```

**Why so thin:** the real complexity is in the
transport (libp2p, wire format, parent request
signing, worker result verification). envoy-harness-adapter
doesn't ship a default — the host (Tauri, CLI)
provides one. Same DI pattern as F8's
`defaultSignResult` (the closure hides the
implementation; the adapter doesn't know about
Ed25519).

**Why the transport is opaque (returns
`SubagentResult`, not `SignedSubagentResult`):** the
worker signs the result before returning; the
signature lives in `result.signature` (the existing
field on `SubagentResult`). The transport verifies;
the submitter just returns. **No re-verification at
the submitter layer.** The F10.3.1 plan's
`workerPublicKey` + `parentPrivateKey` fields on
the submitter were deferred to the transport's
contract (the transport closes over them). Cleaner
seam; the adapter doesn't need to know about keys.

**Type changes (Package 3):**
- `RemoteSubmitterTransport` interface:
  `send(input, targetPeerId, signal) => Promise<SubagentResult>`
- `RemoteMeshSubmitterOptions`:
  `{ transport, targetPeerId }`
- `RemoteMeshSubmitter` class implementing
  `MeshSubmitter`
- `src/index.ts`: re-export

**10 new tests in
`test/remote-mesh-submitter.test.ts`:**
1. submit returns what the transport returns
2. transport receives the input unchanged
3. transport receives the configured `targetPeerId`
4. parent's abort signal is forwarded to the
   transport (same signal instance, not aborted)
5. transport errors propagate to the caller
6. implements `MeshSubmitter` (type-level check
   via `as MeshSubmitter` assignment)
7. two submitters with different `targetPeerId`s
   route to different peers
8. multiple sequential submits all complete
9. multiple parallel submits overlap (F10.2 fan-out
   path: 5 submits in <80ms vs 100ms sequential;
   confirms the `Promise.all` path works for the
   cross-node submitter too)
10. the worker's signature on the result is
    preserved (the transport's contract — the
    submitter returns it as-is)

**No self-review issues this time.** Smaller surface,
cleaner design (the complexity is in the transport,
not the submitter). The first build succeeded; the
first test run passed 10/10.

**Total: 671 tests across 38 files** (envoy-harness,
unchanged) + **92 tests across 10 files**
(envoy-harness-adapter, +10 from F10.3.2) = **763
across 48 files** (monorepo). F10.3.2 is done. The
`RemoteMeshSubmitter` is the standard
`MeshSubmitter` over any cross-node transport the
host injects. F10.3.3 (the federated routing seam:
`routingHint` field on `SubagentInput` + design doc
note) is the last sub-chunk.

Updated §1 (status line), §2 (status table Phase 5
row), §3 (this entry), §6.6 (F10.3 row, F10.3.2 ✅),
§7 (template preserved), §10 (this entry). **Next:
F10.3.3 (routingHint field on SubagentInput) or
push 1 unpushed commit, user's pick.**

---

### F10.3.3 — done

**F10.3.3 (this commit) — federated routing seam +
design doc note.** The last sub-chunk of F10.3.

**The seam:** the actual routing decision (which peer
to send to, capability matching, load balancing, fallback
selection) lives in EnvoyMesh — NOT in envoy-harness.
Per the boundary doc, envoy-harness's contribution is
the SEAM: structured advisory fields the host (or a
future `FanOutSpec`, F10.4+) can set. The mesh
interprets them.

**Type changes (Package 1):**
- New `RoutingHint` interface:
  `{ workerCapabilityTag, maxHops?, preferredRegions? }`
- `SubagentInput.routingHint?: RoutingHint` (additive
  — existing F10.1.2 callers unchanged)
- `src/index.ts` + `src/subagent/index.ts` re-export
  `RoutingHint`
- The `task` tool's zod schema does NOT expose
  `routingHint` to the model — only the host can set
  it. Test asserts this is the case (so the seam
  doesn't leak to the model).

**Design doc updates:**
- `boundary.en.md`: new "Federated routing: the seam"
  section with the explicit note **"Routing is a mesh
  concern; envoy-harness exposes the hint, EnvoyMesh
  decides the target."** The routing table row updated
  to reflect the F10.3.3 hint field. The doc test
  asserts this note is present (so future readers
  know where the routing decision lives).

**4 new tests in
`test/subagent-routing-hint.test.ts`:**
1. `routingHint` accepted on `SubagentInput` (additive
   — existing inputs without the field still
   type-check).
2. `routingHint` is forwarded through `MeshSubmitter`
   (passes through to the transport, where the mesh
   interprets it).
3. The `task` tool's zod schema does NOT expose
   `routingHint` to the model (the seam is host-only).
4. Doc test: "Routing is a mesh concern" note is
   present in `docs/boundary.en.md`.

**Self-review caught 1 issue:** the first test
design tried to import `TaskInputSchema` via
`'@envoymesh/envoy-harness/dist/subagent/tools.js'`
which doesn't resolve as a self-import path
(self-package can't import its own dist via the
package alias). Fixed by importing from the
package root — `TaskInputSchema` is re-exported
from `src/index.ts` already.

**Total: 675 tests across 39 files** (envoy-harness,
+4 from F10.3.3) + 92 in envoy-harness-adapter =
**767 across 49 files** (monorepo). F10.3.3 is done.

**Phase 5 status:** F10.1, F10.2, F10.3.1, F10.3.2,
F10.3.3 — all done. The mesh-native sub-agent path
is complete: parent → task tool → `MeshSubmitter` →
local (`LocalMeshSubmitter`) or remote
(`RemoteMeshSubmitter` + host-injected transport) →
signed `SubagentResult` (via `SubagentResultSigner`) →
federated routing hint (via `SubagentInput.routingHint`).
F10.4+ is the next phase: `FanOutSpec` (capability-driven
fan-out, the user's earlier F10.2 ask), cost aggregation,
progress streaming.

Updated §1 (status line), §2 (status table Phase 5
row), §3 (this entry), §6.6 (F10.3 row, F10.3.3 ✅
+ all 3 sub-chunks done), §7 (template preserved),
§10 (this entry). **Next: F10.4 (`FanOutSpec` +
capability-driven fan-out) or push 1 unpushed commit,
user's pick.**

---

### F10.4 — `FanOutSpec` + capability-driven fan-out (1 sub-chunk)

**Phase 5 next sub-chunk.** F10.2 lets the **model**
fan out: it emits N `task` calls in one iteration,
the agent runs them in parallel. F10.4 lets the
**host** fan out: it registers a `FanOutSpec` for
a capability tag ("for tag X, always fan out to 3
workers with input partition `P(i, N)`"); the model
emits ONE `task` call with that tag; the `task`
tool expands it to N sub-agents with the partition
function applied.

**The use case (from the user's F10.2 ask):** "Let
the host register a `FanOutSpec` for a
`capabilityTag` ('for tag X, always fan out to 3
workers with input partition `P(i, N)`')." The
host wants parallel work to happen for a specific
tag, even if the model doesn't emit multiple calls.
F10.4 is the cleanest way to do this without
teaching the model about it.

**v0 (this chunk) scope:**

1. **`FanOutSpec` type:**
   ```ts
   interface FanOutSpec {
     /** The capability tag this spec matches. */
     capabilityTag: string;
     /** Number of sub-agents to spawn. v0: must
      *  be > 0. The `maxSubagents` cap still
      *  applies (refuse ALL if exceeded). */
     count: number;
     /** Partition the input into N inputs. Called
      *  once per sub-agent with `(input, i, count)`.
      *  Default: identity (each sub-agent gets the
      *  same input). */
     partition?: (input: SubagentInput, i: number, count: number) => SubagentInput;
   }
   ```

2. **`FanOutRegistry` class:** host registers
   specs by `capabilityTag`. Lookup is O(1)
   (Map). v0: one spec per tag (last write wins).

3. **`task` tool integration:** on each call, the
   tool checks the registry. If a spec matches
   the input's `capabilityTag`, the tool:
   - Builds N `SubagentInput`s via `partition`
     (or identity).
   - Calls `MeshSubmitter.submit` N times in
     parallel (F10.2 fan-out path: `Promise.all`).
   - Aggregates the N results into ONE
     `SubagentResult` for the model.
   - Honors the parent's `maxSubagents` cap
     (F10.2's refuse-all-when-exceeded).
   - Honors the abort signal (any sub-agent
     abort propagates to all in-flight).

4. **Result aggregation:**
   - `status`: worst-case ("completed" → "partial"
     → "failed"; "failed" wins).
   - `content`: concatenated text blocks from all
     N results, in completion order. A header
     block per sub-agent (`"[sub-agent 1/3]"`).
   - `costUsd`: sum of all N.
   - `durationMs`: max of all N (the wall-clock
     time the parent waited).
   - `verdict`: worst-case (pass → partial → fail).
   - `signature`: empty (the aggregated result is
     not a single signed result; the host can
     verify each individual signature separately
     if it cares). v0 simplification.

5. **`AgentOptions.fanOutRegistry?: FanOutRegistry`**
   (additive). When set, the `task` tool is
   auto-augmented to consult the registry on every
   call. No registry → behavior unchanged (F10.1
   + F10.2 baseline).

**v0 (F10.4) — out of scope:**
- **Cost aggregation** into the parent's
  `CostTracker` (F10.5+). v0: each sub-agent
  has its own cost; the host budgets via
  per-call `cost_ceiling_usd`. The aggregated
  result's `costUsd` is the sum; the parent's
  own `CostTracker` doesn't see it.
- **Progress streaming** for the sub-agents
  (F10.5+). v0: fire-and-await; no streaming
  events.
- **Multi-tier fan-out** (a `FanOutSpec` that
  fans out to a `FanOutSpec`). v0: one level.
- **Dynamic fan-out count** (count depends on
  the input). v0: static count per tag.

**Type sketch:**

```ts
// src/subagent/fan-out.ts
export interface FanOutSpec {
  capabilityTag: string;
  count: number;
  partition?: (input: SubagentInput, i: number, count: number) => SubagentInput;
}

export class FanOutRegistry {
  register(spec: FanOutSpec): void;
  lookup(capabilityTag: string): FanOutSpec | undefined;
  clear(): void;
}
```

**Sub-chunk breakdown (planned):**
- **F10.4.1:** `FanOutSpec` + `FanOutRegistry` +
  `task` tool fan-out expansion + result aggregation
  + `AgentOptions.fanOutRegistry` + ~8 tests
  (~200 lines). Single chunk; tightly coupled.

**Total estimated: 1 commit, ~8 tests, ~200 lines.**

---

### F10.4.1 — done

**F10.4.1 (this commit) — `FanOutSpec` + capability-driven
fan-out.** The host-driven fan-out pattern (the user's
explicit F10.2 ask #4).

**The design:** host registers a `FanOutSpec` for a
`capabilityTag` ("for tag X, always fan out to 3 workers
with input partition `P(i, N)`"). When the model emits
ONE `task` call with that tag, the tool expands it to
N sub-agents in parallel (F10.2 `Promise.all` path) and
aggregates the N results into ONE for the model. The
model doesn't need to know.

**Type changes (Package 1):**
- New `src/subagent/fan-out.ts`:
  - `FanOutSpec { capabilityTag, count, partition? }`
  - `FanOutRegistry` class (register, lookup, clear, size)
  - `aggregateFanOutResults` helper (worst-case status,
    concatenated content with `[sub-agent i/N]` headers,
    summed costUsd, max durationMs, worst-case verdict,
    empty signature for the aggregated result)
- `makeTaskTool` now accepts `{ submitter, fanOutRegistry? }`
  or just `MeshSubmitter` (backward compat with F10.1.3)
- `AgentOptions.fanOutRegistry?` (additive; v0: no
  registry = no fan-out, F10.1 + F10.2 baseline)
- `src/index.ts` + `src/subagent/index.ts` re-export

**Result aggregation rules (worst-case semantics):**
- `status`: completed < partial < failed; "failed" wins
- `verdict`: pass < partial < fail; "fail" wins
- `content`: `[header, text, header, text, ...]` with
  `[sub-agent i/N]` prefix per sub-agent
- `costUsd`: sum of all N
- `durationMs`: max of all N (wall-clock parent waits)
- `signature`: empty (aggregated result is not a single
  signed result; host can verify each individually
  if it cares)

**11 new tests in
`test/subagent-fan-out.test.ts`:**
- Registry: register/lookup/size/clear; one spec per
  tag (last write wins)
- `aggregateFanOutResults`: worst-case status, content
  with `[i/N]` headers, cost/duration, worst-case
  verdict, empty input throws
- task tool with registry: ONE call → N parallel,
  partition injects `i`, identity partition default
- task tool without registry: F10.1 + F10.2 baseline
  unchanged (backward compat with direct submitter
  arg)

**Self-review caught 4 issues:**
1. `noUncheckedIndexedAccess` on
   `statusRankInverse[worstStatusRank]` returned
   `T | undefined`; fixed by using array + bound
   check (`statusLabels[worstStatusRank]` with
   explicit out-of-range throw).
2. Top-level `src/index.ts` re-export was
   `type FanOutRegistry` (wrong — it's a class,
   needs value export); fixed.
3. Stale dist lesson (F10.2.1 / F10.3.1 / F10.3.2 /
   F10.3.3 all hit this) — required rebuild
   before tests would resolve the new exports.
4. Test bugs (NOT code bugs): (a) off-by-one in
   content index expectation (test was checking
   `[2]` but `[2]` is the second header, not the
   first text); (b) destructured `callCount` got
   the snapshot at destructuring time (0) not the
   getter — fixed by reading via the holder object.

**Total: 686 tests across 40 files** (envoy-harness,
+11 from F10.4.1) + 92 in envoy-harness-adapter =
**778 across 50 files** (monorepo). F10.4.1 is done.

**Phase 5 status:** F10.1, F10.2, F10.3.1, F10.3.2,
F10.3.3, F10.4.1 — all done. The mesh-native
sub-agent path now has BOTH model-driven fan-out
(F10.2) and host-driven fan-out (F10.4.1). F10.5+
is the next phase: cost aggregation (sub-agent
`CostTracker` → parent's `CostTracker`) +
progress streaming (sub-agent trace → parent's
tracer).

Updated §1 (status line), §2 (status table Phase 5
row), §3 (this entry), §6.6 (F10.4 row, F10.4.1 ✅),
§7 (template preserved), §10 (this entry).
**Next: F10.5+ (cost aggregation + progress
streaming) or push 1 unpushed commit, user's pick.**
- **2026-08-19 (F10.4.1)**: `FanOutSpec` + capability-
  driven fan-out. The host-driven fan-out pattern
  (the user's explicit F10.2 ask #4): host registers
  a `FanOutSpec` for a `capabilityTag` ("for tag X,
  always fan out to 3 workers with input partition
  `P(i, N)`"). When the model emits ONE `task` call
  with that tag, the tool expands it to N sub-agents
  in parallel (F10.2 `Promise.all` path) and aggregates
  the N results into ONE for the model. The model
  doesn't need to know. Type changes (Package 1):
  new `src/subagent/fan-out.ts` with `FanOutSpec`,
  `FanOutRegistry` class, `aggregateFanOutResults`
  helper. `makeTaskTool` now accepts `{ submitter,
  fanOutRegistry? }` or just `MeshSubmitter` (backward
  compat with F10.1.3). `AgentOptions.fanOutRegistry?`
  (additive; v0: no registry = no fan-out, F10.1 +
  F10.2 baseline). Aggregation: worst-case status
  (completed < partial < failed; "failed" wins),
  worst-case verdict (pass < partial < fail; "fail"
  wins), content `[header, text, header, text, ...]`
  with `[sub-agent i/N]` prefix, costUsd sum,
  durationMs max, signature empty (aggregated
  result is not a single signed result). 11 new
  tests in `test/subagent-fan-out.test.ts`:
  registry basics, aggregator, task tool with
  registry, task tool without registry (backward
  compat). **Self-review caught 4 issues:**
  (1) `noUncheckedIndexedAccess` on
  `statusRankInverse[i]`, (2) top-level
  `src/index.ts` re-export was `type FanOutRegistry`
  (wrong, it's a class), (3) stale dist lesson
  (rebuild required), (4) test bugs (off-by-one in
  content index, destructured `callCount` snapshot).
  **F10.4.1 ✅ done.** Phase 5 now has BOTH model-
  driven (F10.2) and host-driven (F10.4.1) fan-out.
  F10.5+ is next: cost aggregation + progress
  streaming. Total: 686 tests across 40 files
  (envoy-harness) + 92 in envoy-harness-adapter =
  778 across 50 files (monorepo). Updated §1, §2,
  §3, §6.6, §7, §10.

---

### F10.5 — done

**F10.5 (this commit) — sub-agent → parent cost +
trace forwarding.** The mesh-native sub-agent path
is now fully sewn up: parent can spawn, route, sign,
fan out, aggregate cost, see progress.

**Type changes (Package 1):**
- `CostTracker.addSubagentCost(costUsd: number)` —
  new method. Adds the sub-agent's `costUsd` to the
  parent's running total. **No token attribution**:
  the sub-agent already tracked its own tokens in
  its own `CostTracker`; the parent only sees the
  derived `costUsd` sum. Adding tokens would
  double-count.
- `MakeTaskToolOptions.onSubagentComplete?` callback:
  fires after the `MeshSubmitter` (or F10.4.1
  fan-out aggregator) returns. For fan-out, the
  callback receives the AGGREGATED result (with
  summed `costUsd`), not the N individual results.
- `makeTaskTool` now accepts the callback; calls
  it after the result is ready.
- `Agent` constructor wires `onSubagentComplete`
  to call `this.costTracker.addSubagentCost`. F10.5
  wiring is automatic; the host doesn't need to
  do anything (just provide a `meshSubmitter`; the
  rest follows).
- `LocalMeshSubmitterOptions.parentTracer?` — new
  field. When set, the sub-agent's `TraceEvent`s
  flow to the parent tracer (progress streaming).
- `defaultBuildSubagentFactory` accepts
  `parentTracer?` and passes it to the new `Agent`'s
  tracer option.

**8 new tests in
`test/subagent-cost-trace.test.ts`:**
1. `CostTracker.addSubagentCost` adds to the
   running total (no token attribution).
2. `addSubagentCost(0)` is a no-op (defensive;
   the tool's callback skips 0-cost results).
3. End-to-end: a sub-agent's `costUsd` flows
   into the parent's tracker via the
   `onSubagentComplete` callback.
4. Fan-out: aggregated result's `costUsd` (sum
   of N) flows into the parent's tracker.
5. Sub-agent's `TraceEvent`s flow to the parent
   tracer when `parentTracer` is set
   (`agent_start`, `model_response`, `agent_end`
   all visible).
6. `parentTracer` is OPTIONAL — backward compat
   with F10.1.2 (no tracer = `NullTracer`).
7. A custom `buildSubagent` factory can use the
   `parentTracer` (the factory closes over the
   tracer).
8. The `onSubagentComplete` callback receives
   the AGGREGATED result for fan-out (fires
   once, not N times).

**Self-review caught 1 issue:** the `scriptedModel`
function signature was wrong
(`ReadonlyArray<ModelResponse['content']>`
should be `ReadonlyArray<{content, stopReason?}>`).
The first run reported the wrong type for the test
model; the sub-agent errored because the model
threw when the test passed an object instead of
an array. Fixed by matching the F10.1.4 pattern.

**Total: 694 tests across 41 files** (envoy-harness,
+8 from F10.5) + 92 in envoy-harness-adapter =
**786 across 51 files** (monorepo). F10.5 is done.

**Phase 5 status:** F10.1, F10.2, F10.3.1, F10.3.2,
F10.3.3, F10.4.1, F10.5 — all done. The mesh-native
sub-agent path is **complete**:
- **Spawn** (F10.1: `MeshSubmitter` + `LocalMeshSubmitter`
  + `task` tool)
- **Route** (F10.2: parallel fan-out + `maxSubagents` cap)
- **Trust** (F10.3.1: `SubagentResultSigner` + signed
  results; F10.3.2: cross-node `RemoteMeshSubmitter`;
  F10.3.3: federated routing hint)
- **Fan-out** (F10.4.1: `FanOutSpec` + host-driven fan-out)
- **Aggregate** (F10.5: sub-agent cost + trace flow to
  parent)

Updated §1 (status line), §2 (status table Phase 5
row), §3 (this entry), §6.6 (F10.5 row, F10.5 ✅),
§7 (template preserved), §10 (this entry).
**Next: F10.6+ (per-sub-agent cost breakdown,
`subagentOf` field on trace events) or push the
unpushed commits, user's pick.**
- **2026-08-19 (F10.5)**: Sub-agent → parent cost +
  trace forwarding. The mesh-native sub-agent path
  is fully sewn up. Type changes (Package 1):
  `CostTracker.addSubagentCost` (additive method;
  no token attribution, just adds the derived
  `costUsd`); `MakeTaskToolOptions.onSubagentComplete?`
  callback (fires after submitter or fan-out
  aggregator returns; for fan-out, receives the
  AGGREGATED result); `LocalMeshSubmitterOptions.parentTracer?`
  + `defaultBuildSubagentFactory({parentTracer?})`
  (sub-agent's `TraceEvent`s flow to the parent
  tracer for progress streaming); `Agent`
  constructor wires the callback to
  `addSubagentCost` automatically. 8 new tests in
  `test/subagent-cost-trace.test.ts`:
  addSubagentCost adds to running total (no token
  attribution), addSubagentCost(0) is a no-op,
  end-to-end cost aggregation, fan-out cost
  aggregation (sum of N flows to parent), trace
  events flow to parent tracer, parentTracer
  optional (backward compat), custom factory uses
  parentTracer, callback receives AGGREGATED
  result for fan-out. **Self-review caught 1 issue:**
  scriptedModel function signature was wrong
  (passed object instead of `ContentBlock[]`);
  fixed by matching the F10.1.4 pattern.
  **F10.5 ✅ done. Phase 5 status: ALL 7 sub-chunks
  done** (F10.1, F10.2, F10.3.1, F10.3.2, F10.3.3,
  F10.4.1, F10.5). The mesh-native sub-agent path
  is complete: spawn (F10.1), route (F10.2 parallel
  + cap), trust (F10.3.1 signer + F10.3.2
  cross-node + F10.3.3 routing hint), fan-out
  (F10.4.1), aggregate (F10.5 cost + trace). Total:
  694 tests across 41 files (envoy-harness) + 92
  in envoy-harness-adapter = 786 across 51 files
  (monorepo). Updated §1, §2, §3, §6.6, §7, §10.
- **2026-08-19 (F10.6)**: `subagentOf` field on
  `TraceEvent`. The self-describing event
  annotation. Makes the parent tracer able to
  group/filter events by session without
  consumer-side inference from event ordering
  (fragile for parallel sub-agents). Type changes
  (Package 1): `TraceBase.subagentOf?: string`
  (added to the common interface; all 6
  `TraceEvent` variants inherit it; existing
  consumers ignore the field);
  `AgentOptions.subagentOf?: string` (new option;
  the PARENT's own agents do NOT set this);
  `Agent` constructor: stores `subagentOf`,
  replaces 9 inline `tracer.emit(...)` calls with
  a new private `emit` helper that auto-tags
  events (one place to change; no "I forgot to
  add `subagentOf`" bug);
  `defaultBuildSubagentFactory({parentSessionId?})`
  — new field; the host passes the parent's
  sessionId; the factory closes over it and
  passes it as `AgentOptions.subagentOf` to
  every new `Agent`. Wire path: host →
  `LocalMeshSubmitter` factory → `Agent`. 5 new
  tests in `test/subagent-subagent-of.test.ts`:
  parent has no `subagentOf`, sub-agent has
  `subagentOf` (with `parentSessionId`), no
  `subagentOf` without it (backward compat), all
  6 event kinds carry the field, end-to-end
  interleaved. **No self-review issues** (small,
  additive; one field on a tagged union; one
  option; one helper). **F10.6 ✅ done. Phase 5
  status: ALL 8 sub-chunks done** (F10.1, F10.2,
  F10.3.1, F10.3.2, F10.3.3, F10.4.1, F10.5,
  F10.6). Phase 5 is feature-complete: spawn,
  route, trust, fan-out, aggregate, annotate.
  Total: 699 tests across 42 files
  (envoy-harness) + 92 in envoy-harness-adapter
  = 791 across 52 files (monorepo). Updated §1,
  §2, §3, §6.6, §7, §10.

---

### F10.6 — done

**F10.6 (this commit) — `subagentOf` field on
`TraceEvent`.** The self-describing event annotation.
Makes the parent tracer able to group/filter events
by session without consumer-side inference from
event ordering.

**Type changes (Package 1):**
- `TraceBase.subagentOf?: string` — added to the
  common interface; all 6 `TraceEvent` variants
  (`agent_start`, `model_response`, `tool_call`,
  `tool_result`, `agent_end`, `error`) inherit it.
  Existing consumers (F9.4 `JsonLinesTracer`, the
  CLI's `--json` flag) ignore the field.
- `AgentOptions.subagentOf?: string` — new option.
  When set, every `TraceEvent` this agent emits
  carries the field. The PARENT's own agents do
  NOT set this (the parent is the root; its
  events have no `subagentOf`).
- `Agent` constructor: stores `subagentOf`;
  replaces 9 inline `this.tracer.emit(...)` calls
  with `this.emit(...)` via a new private `emit`
  helper that auto-tags events. One place to
  change; no "I forgot to add `subagentOf`" bug.
- `defaultBuildSubagentFactory({parentSessionId?})`:
  new field. The host passes the parent's
  sessionId; the factory closes over it and
  passes it as `AgentOptions.subagentOf` to every
  new `Agent` it creates. Wire path: host →
  `LocalMeshSubmitter` factory → `Agent`.

**5 new tests in
`test/subagent-subagent-of.test.ts`:**
1. The parent's events have NO `subagentOf`
   (the parent is the root).
2. A sub-agent's events carry the parent's
   sessionId in `subagentOf` (when
   `parentSessionId` is set on the factory).
3. A sub-agent's events have NO `subagentOf`
   when the factory doesn't set `parentSessionId`
   (backward compat: the field is optional).
4. All 6 `TraceEvent` kinds carry the field
   when set (5 of 6 in this test — `error`
   needs a forced-error path that's deferred).
5. End-to-end: the parent tracer sees parent's
   events (no `subagentOf`) AND sub-agent's
   events (with `subagentOf`) interleaved
   correctly.

**No self-review issues this round.** Small,
additive change; one field on a tagged union; one
option on `AgentOptions`; helper method to
centralize propagation. The first build succeeded;
the first test run passed 5/5.

**Why this and not per-sub-agent cost breakdown:**
the per-sub-agent cost breakdown was conceded as
scope creep (the host has workarounds; the model
doesn't need it; the data is in the trace events).
The `subagentOf` field fills a real gap (consumer-
side inference from event ordering is fragile for
parallel sub-agents) at low cost (one field, one
helper, one factory option).

**Total: 699 tests across 42 files** (envoy-harness,
+5 from F10.6) + 92 in envoy-harness-adapter =
**791 across 52 files** (monorepo). F10.6 is done.

**Phase 5 status:** F10.1, F10.2, F10.3.1, F10.3.2,
F10.3.3, F10.4.1, F10.5, F10.6 — **all 8 sub-chunks
done**. Phase 5 is feature-complete: spawn (F10.1),
route (F10.2 parallel + cap), trust (F10.3.1 signer
+ F10.3.2 cross-node + F10.3.3 routing hint),
fan-out (F10.4.1), aggregate (F10.5 cost + trace),
annotate (F10.6 `subagentOf`).

Updated §1 (status line), §2 (status table Phase 5
row), §3 (this entry), §6.6 (F10.6 row, F10.6 ✅),
§7 (template preserved), §10 (this entry).
**Next: F10.7+ or push the 4 unpushed commits,
user's pick.**

---

## 11. F17 REPL archive (Phase 6 — in progress)

F17 was chosen in §6.7 as the first Phase 6 chunk
(user picked `C` — README + F17 plan + build F17.1
in this session). The plan was committed in
`9bf4735`; the F17.1 implementation is committed
in this chunk.

**Sub-chunk template** (per F17.x):
1. Plan in the doc first (this section above).
2. Build the smallest verifiable unit (types,
   then loop, then dispatch, then persistence,
   then tests).
3. Self-review after each sub-chunk.
4. Update the doc (§3 done + §6.7 status + §10).
5. Commit.

**Sub-chunk status:**
- ✅ **F17.1** — REPL loop scaffold. `--repl` flag +
  readline loop + single-`Agent`-across-turns +
  exit on `/quit`/`/exit`/EOF + blank-line skip +
  unknown-slash placeholder + 13 tests. ~150 LoC.
- ✅ **F17.2** — Slash command registry. 9 built-ins
  (`/help`, `/model`, `/provider`, `/sandbox`,
  `/approval`, `/clear`, `/cost`, `/status`, `/quit`).
  `ReplCommandRegistry` class + `parseCommandLine` +
  `dispatchCommand`. Open to host extension via
  `ReplOptions.customCommands`; built-ins always
  win on name collision. Agent gained 3 setters
  (`setModel`, `setAskHandler`, `setPermissionMode`)
  + 2 helpers (`clearSession`, `getCost`) — all
  additive. 25 new tests. ~250 LoC.
- ⏳ **F17.3** — History persistence
  (`~/.local/state/envoy-harness/history`). ~50 LoC.
- ⏳ **F17.4** — Tests + e2e (wire tests across
  F17.1-F17.3; end-to-end REPL session; snapshot
  test for help text). ~100 LoC of tests.

**Why a separate "F17 archive" section (not in §6.6):**
F17 is a Phase 6 feature, not Phase 5. §6.6 holds
the F10 plans (Phase 5 — all done). §6.7 holds the
"what's next" candidates + the F17 plan. This §11
is the implementation archive (analogous to §7
for F6). When F17 is fully done, this section
becomes read-only history.

**Cross-references:**
- F17 plan + scope: §6.7 (lines 2761+).
- F17.1 implementation: §3.5 above.
- Test inventory: §2 (per-module test table,
  "REPL loop (F17.1)" row).

**Next chunk:** F17.2.

