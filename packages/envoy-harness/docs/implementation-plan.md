# envoy-harness implementation plan

> **Purpose.** The single source of truth for "what we did, what
> we are doing, what we plan to do." Use this to onboard,
> resume after a break, and decide what's next.
>
> **Companion to `docs/design.en.md`.** The design says *what*
> and *why*. This file says *what shipped*, *where it lives*,
> and *what's still open*.
>
> **Status as of last commit:** (next commit, F9.3 done) on `phase-1/types`.
> Total: 564 tests, 28 test files, 40 source files, ~17k lines (monorepo: 2 packages).
> Phase 3 fully complete (F6 done). Phase 2 fully complete (F7 + F8 done, F8 polish done). **Phase 4 in progress (F9.1 + F9.2 + F9.3 + F9.4 done; F9.5 pending: cross-verify).**

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
| Federated pull (F6.1) | 11 | `test/federated.test.ts` | PeerSource, LocalPeerSource, filter+verify, opt-in default |
| Federated local gate (F6.2) | 6 | `test/federated-local-gate.test.ts` | runOneCycleAgainst, adopt() splitting |
| Federated adoptions (F6.3) | 7 | `test/federated-adoptions.test.ts` | appendAdoption, audit trail (kept + rejected) |

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
| **F9.5** | Cross-agent verification. The `verify()` path can take an optional `crossVerifyWith` closure. When provided, the adapter calls it on the result and returns the cross-verify verdict in addition to its own. The orchestrator combines per design §6.2 (OR-of-pass, AND-of-fail). v0 in this chunk: a default cross-verify closure that re-runs the same skill on a different `ModelAdapter` (e.g. cheap local model vs. expensive GPT-4). | design §12.4 (4-source cascade), MAP §CrossAgentDisagreementVerifier | ⏳ pending |

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

**Why F9.5 last (cross-agent verification):**
needs the most cross-cutting work — adapter
extension, verifier extension, model router
infrastructure. Likely 8-12 commits.

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

## 7. Phase breakdown (per design §22)

| Phase | Weeks | Scope | Status |
|-------|-------|-------|--------|
| 0 | 1 day | Empty package skeleton | ✅ done |
| 1 | 4 weeks | v0 spine: types, validators, hooks, AGENTS.md, tools, agent loop, CLI, verifier | ✅ done |
| 2 | 4 weeks | Mesh-native: adapter, manifest broadcast, task submission, reputation book, persistence, real LLM adapters, cost tracking | 🟡 F7 done (real LLM adapters + cost tracking); F8 (envoy-harness-adapter) next |
| 3 | 3 weeks | Self-evolution: 5-step protocol, federated scoreboard, owner-key-signed entries | ✅ done (5a-5e + F6) |
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
