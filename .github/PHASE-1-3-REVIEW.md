# Phase 1 + Phase 3 review (envoy-harness v0 spine + self-evolution)

> **TL;DR** — Phase 1 v0 spine (types, bash validators, AGENTS.md
> discovery, hook registry, tool registry, built-in tools, agent
> loop, CLI, verifier rule engine) and Phase 3 self-evolution
> scaffold (scoreboard, 5-step protocol, frozen benchmark,
> shadow cycle, `envoy self-evolve` CLI subcommand) are landed
> on `phase-1/types`. **305 tests across 16 files, all
> passing; typecheck clean.** This PR is the combined review
> entry-point; it bundles 11 commits from the empty package
> skeleton through the first complete self-evolution cycle.

---

## What's in this branch

11 commits, in dependency order:

| Commit  | Phase | What it adds |
|---------|-------|--------------|
| `e845c30` | P1/1 | Local type system (43 tests). §5.1-§5.6. |
| `29db17f` | P1/2 | 6 bash validators + 200-command parity fixture (47 tests). §6. |
| `a211af2` | P1/3 | AGENTS.md discovery (24 tests) + hook registry (42 tests). §8 + §9. |
| `bebd30f` | P1/4a | Tool type, ToolRegistry, ModelAdapter, Session (22 tests). §3.2, §3.4, §10. |
| `37079cb` | P1/4b | read_file + bash built-in tools + Agent loop (56 tests). §3.4, §10. |
| `4d104cc` | P1/4c | CLI argv parser + runner + e2e (24 tests). §19. |
| `16a6bf1` | P1/4d | Verifier rule engine (26 tests). §12.1, §12.2. |
| `f8b77ef` | P3/5a | Scoreboard data layer (16 tests). §13 data. |
| `1dc8009` | P3/5b | SelfEvolve class + 5-step protocol (19 tests). §13.1. |
| `8ed45fc` | P3/5c+5d | Frozen benchmark fixture + shadow cycle e2e (4 tests). §13. |
| `02e9873` | P3/5e | `envoy self-evolve` CLI subcommand. §19. |

Total: **+27 source files, +15 test files, 305 tests.**

## How to verify locally

```sh
pnpm install
pnpm test                      # 305 tests, ~1s
pnpm typecheck                 # tsc --noEmit, clean
pnpm envoy --help              # v0 flag set
pnpm envoy self-evolve --help  # §13 subcommand
```

## Phase 1 milestone (per design §22)

> All file skeletons exist; the 6 bash validators are real; the
> AGENTS.md discovery is real; the hook registry is real; the
> verifier rule engine is real; the agent loop runs; the CLI
> takes a prompt and returns a response.

**All seven items done.**

Tests:
> Parity test for the 6 bash validators, AGENTS.md discovery,
> hook events, agent loop on a mock model.

**All four items done.**

## Phase 3 milestone (per design §22)

> 5-step protocol scaffold complete. First cycle runs in
> shadow mode (no commit). Owner-key-signed scoreboard entries.
> Federated scoreboard opt-in (off by default).

**3 of 4 items done.** Federated scoreboard (§13.3) is
deferred — it's an opt-in cross-peer exchange; we built the
local-only scaffold first. Track it as a follow-up.

## Architectural invariants (per §4)

- **Zero EnvoyMesh-internal deps** — Package 1 (this branch)
  has no `import` from `@envoymesh/*`. Adapter (Package 3) is
  the bridge. Per design target #2/#4.
- **Capability seams complete** — bash validation, hooks,
  tools, model, session, verifier each have Service Definition
  / Provider / Consumer roles. Per glossary.
- **Local types mirror wire types** — `Verdict`, `VerifierSource`,
  `SkillId`, `AgentRuntime` are defined locally and match the
  wire values verbatim. Adapter (Package 3) translates.
- **`exactOptionalPropertyTypes: true`** respected throughout.
- **Tree-shakable runners** — `runShellHandler` /
  `runModuleHandler` are dynamic-imported only when a
  declarative `HookHandler` is registered.
- **Test isolation** — every test gets a fresh
  `HookRegistry` / `ToolRegistry` / `Session` / `SelfEvolve`.
  `FakeModel` snapshots its input so test assertions don't see
  later mutations.

## Self-evolution contamination guard (the safety net)

`buildHypothesisPrompt` (test/`self-evolve.test.ts`) is the
**only** way the optimizer sees input. The test verifies the
prompt does NOT contain the words `benchmark`, `gold`,
`rubric`, or `frozen`. The end-to-end test
(`self-evolve-e2e.test.ts`) goes further: it embeds a unique
secret phrase in the benchmark's `objective` field and asserts
the captured prompt does NOT contain it. This is the
guarantee the design requires.

Shadow mode is the default — the operator inspects the
scoreboard history before enabling `--commit`.

## Risk areas to look at

1. **`policyFromMode` duplication** — the bash tool
   (`src/tools/builtin/bash.ts`) and the agent (`src/agent.ts`)
   independently derive `SandboxPolicy` from the session's
   permissionMode. They MUST stay in sync. Consider extracting
   a single helper in a follow-up.
2. **`defaultRegistry` is module-level state** — used in
   `HookRegistry`'s default and exposed publicly. Tests don't
   touch it (they use `new HookRegistry()` per test), so no
   pollution risk in v0.
3. **`Agent.abort()` semantics** — calling `agent.abort()`
   while a model call is in flight does NOT cancel the
   in-flight call. The current iteration finishes, then the
   loop checks the flag and exits. Streaming cancellation is
   a v0+ concern.
4. **`hashRuleset` sensitivity** — depends on rule names +
   descriptions only. Adding a new rule to the ruleset
   changes the hash. Phase 2 (mesh-native) will need a
   version-aware hash; v0 is fine.
5. **Sign entry (SHA-256 vs Ed25519)** — v0 signs with
   SHA-256 of the canonical payload. Real Ed25519 signing
   needs the owner key, which is a separate concern (see
   `notes/pending/owner-key.md` once it lands). Until then,
   the scoreboard is tamper-resistant only against accidental
   edits, not against a malicious process.

## Review focus

- `src/agent.ts` — the 5-step loop (per design §3.4). Order:
  model → assistant msg → extract tool_calls → for each:
  PreToolUse → arg validation → execute → PostToolUse → tool
  result. Loop until no tool calls or abort.
- `src/permissions/bash/index.ts` — the 6-validator composition
  (first pass: blocks; second pass: warnings; otherwise allow).
- `src/agents-md/discover.ts` — the 5-step discovery
  (find root → collect paths → read respecting maxBytes →
  read override → assemble with origin/path comments).
- `src/hooks/registry.ts` — `on()` accepts both `HookFn`
  (function) and `HookHandler` (declarative object). Decision
  composition: first block wins; all add-context concatenate;
  last modify wins for PostToolUse only.
- `src/verifier/rules/index.ts` — the 6 rules. v0 caveats:
  `sandbox-respected` and `approval-respected` are string-level
  checks; thorough arg-vs-policy cross-referencing is Phase 2.
  `cost-reasonable-for-work` abstains (no metrics in v0).
- `src/scoreboard/self-evolve.ts` — the 5-step protocol.
  Pay attention to: shadow mode default, strict-greater
  comparison for kept, scoreboard entry shape, snapshot
  before evaluating.
- `src/scoreboard/self-evolve.ts:buildHypothesisPrompt` — the
  contamination guard. The test explicitly verifies the
  prompt does NOT mention benchmark / gold / rubric / frozen.
  Anything in this function that could leak the benchmark
  is a security bug.
- `src/cli/argv.ts` — the discriminated union. `RunParsedArgs`
  vs `SelfEvolveParsedArgs`. The first non-flag positional
  selects the subcommand (`self-evolve` is the only one in
  v0; the default is `run`).

## Phase 2 / Phase 3 follow-ups (not in this PR)

- **Real LLM adapters** — `OpenAIAdapter`, `AnthropicAdapter`,
  `DeepSeekAdapter`. Pluggable via the existing `ModelAdapter`
  interface. The bin script wires the default; users pick via
  `--model` / `--provider`.
- **Cost tracking** (§14) — needed for the verifier's
  `cost-reasonable-for-work` rule to be useful. The hook is
  the natural chokepoint (PostToolUse fires after every tool
  call).
- **Persistence** — `--resume` and `--fork` are accepted in
  argv but not wired. Phase 2 (mesh-native) introduces
  `$ENVOY_HOME/sessions/`.
- **`envoy-harness-adapter` (Package 3)** — the MAP protocol
  translation. Lives in a separate package; this branch
  remains EnvoyMesh-internal-dep-free per design target #2.
- **Federated scoreboard** (§13.3) — opt-in cross-peer rule
  exchange. Local 5-step protocol remains the final gate.
- **JSON Lines streaming, REPL, slash commands** — `--json` is
  accepted, `--quiet` works; the rest is single-shot for v0.

Closes the Phase 1 v0 spine milestone and the Phase 3
self-evolution scaffold milestone, per `docs/design.md` §22.
