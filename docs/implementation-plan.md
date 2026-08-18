# envoy-harness implementation plan

> **Purpose.** The single source of truth for "what we did, what
> we are doing, what we plan to do." Use this to onboard,
> resume after a break, and decide what's next.
>
> **Companion to `docs/design.en.md`.** The design says *what*
> and *why*. This file says *what shipped*, *where it lives*,
> and *what's still open*.
>
> **Status as of last commit:** `02e9873` on `phase-1/types`.
> Total: 305 tests, 16 test files, 27 source files, ~10.7k lines.

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
| **Phase 2** | Mesh-native (4 weeks) | 🔜 next | — |
| **Phase 3** | Self-evolution (3 weeks) | 🟡 scaffold done (5a-5e); federated §13.3 pending | 85 |
| **Phase 4** | Production-grade (ongoing) | ⏳ not started | — |

**Cumulative:** 305 tests across 16 files, all passing.
Typecheck clean (`pnpm typecheck`).

**Per-module test inventory:**

| Module | Tests | File | Coverage |
|--------|-------|------|----------|
| Smoke (version export) | 1 | `test/smoke.test.ts` | basic |
| Type system (§5) | 43 | `test/types.test.ts` | every schema + cross-field |
| Bash validators (§6) | 47 | `test/permissions-bash.test.ts` | 200-command parity fixture |
| Hook registry (§8.2-3) | 42 | `test/hooks-registry.test.ts` | middleware, modify, decision composition, runners |
| AGENTS.md discovery (§9) | 24 | `test/agents-md.test.ts` | 5-step algorithm, fixtures in `agents-md-fixtures/` |
| Tool registry (§10) | 12 | `test/tools-registry.test.ts` | register, lookup, duplicate error |
| bash tool | 12 | `test/tools-bash.test.ts` | permission modes, output capture, timeout, abort |
| read_file tool | 5 | `test/tools-read-file.test.ts` | success, maxBytes, ENOENT, EISDIR |
| Session | 10 | `test/session.test.ts` | append-only, content-block copy, newSessionId uniqueness |
| Agent loop (§3.4) | 17 | `test/agent.test.ts` | single-turn, tool flow, hook integration, limits, model error |
| CLI (§19) | 24 | `test/cli.test.ts` | argv parsing (run + self-evolve), runner, error paths |
| E2E | 3 | `test/e2e.test.ts` | read → run → summarize (direct + via CLI) |
| Verifier rule engine (§12) | 26 | `test/verifier.test.ts` | each of 6 rules, runVerifierRules, combineVerdicts |
| Scoreboard data (§13) | 16 | `test/scoreboard.test.ts` | schemas, file I/O, hash, sign |
| Self-evolve (§13.1) | 19 | `test/self-evolve.test.ts` | contamination guard, parseHypothesis, 5 steps |
| Self-evolve e2e (§13) | 4 | `test/self-evolve-e2e.test.ts` | frozen benchmark, shadow cycle, end-to-end contamination |

---

## 3. Done work (chronological, by commit)

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

### 5.7 No real LLM adapter yet
**Where:** the bin script throws a useful error if no
model is wired. Production users need to inject one
(or wait for Package 4 / separate `llm` package).

### 5.8 `parseArgs` returns a discriminated union
**Where:** `src/cli/argv.ts` — every caller must narrow on
`subcommand`. Tests use a `parseRun()` helper. The next time
we add a subcommand, the pattern repeats.

---

## 6. Planned work (the next 3 follow-ups, in order)

### 6.1 F6 — Federated scoreboard (§13.3)
**Status:** pending. Phase 3 milestone is "3 of 4"; this is
the 4th.

**Scope:**
- `FederatedScoreboard` class (`src/scoreboard/federated.ts`).
- Opt-in flag on the CLI (`envoy self-evolve --federated`).
- Pull protocol: query bonded peers for their public
  scoreboard; for each `kept` entry, run the local 5-step
  protocol as the final gate.
- **Pull is opt-in, never push.** A peer never receives
  rules automatically; the operator must opt in, and the
  local 5-step protocol is the final gate.

**Tests:** 8-12 tests covering opt-in default, pulled
candidate validation, kept adoption recording, signature
verification on the pulled entries.

**Why this is next:** the local 5-step protocol works;
the federated layer is an additive cross-peer exchange. It
doesn't change the local protocol.

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

## 7. Phase breakdown (per design §22)

| Phase | Weeks | Scope | Status |
|-------|-------|-------|--------|
| 0 | 1 day | Empty package skeleton | ✅ done |
| 1 | 4 weeks | v0 spine: types, validators, hooks, AGENTS.md, tools, agent loop, CLI, verifier | ✅ done |
| 2 | 4 weeks | Mesh-native: adapter, manifest broadcast, task submission, reputation book, persistence | 🟡 next (F7) |
| 3 | 3 weeks | Self-evolution: 5-step protocol, federated scoreboard, owner-key-signed entries | 🟡 scaffold (5a-5e) + F6 |
| 4 | ongoing | LSP, team, cron, trace UI, per-call approval, cross-agent verification | ⏳ not started |

**Phase 1 milestone (per design §22):** "All file skeletons
exist; the 6 bash validators are real; the AGENTS.md
discovery is real; the hook registry is real; the verifier
rule engine is real; the agent loop runs; the CLI takes
a prompt and returns a response." — All 7 done.

**Phase 3 milestone (per design §22):** "5-step protocol
scaffold complete. First cycle runs in shadow mode (no
commit). Owner-key-signed scoreboard entries. Federated
scoreboard opt-in (off by default)." — 3 of 4 done
(federated is F6).

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
