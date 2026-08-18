# Phase 1 wrap-up review

> **TL;DR** — envoy-harness Phase 1 v0 spine is complete. The 6
> bash validators, AGENTS.md discovery, hook registry, tool
> registry + 2 built-in tools (read_file, bash), agent loop, CLI
> (argv + runner + e2e), and verifier rule engine (6 rules) are
> all in. **263 tests across 13 files, all passing; typecheck
> clean.** This PR is the review entry-point; it lands 7 commits
> that go from the empty package skeleton to a runnable CLI.

---

## What's in this branch

7 commits, in dependency order:

| Commit  | Chunk | What it adds |
|---------|-------|--------------|
| `e845c30` | 1 | Local type system (43 tests). §5.1-§5.6 of the design: permissions, sandbox, bash validators, hook events, AGENTS.md, verdict. |
| `29db17f` | 2 | 6 bash validators + 200-command parity fixture (47 tests). §6 of the design. |
| `a211af2` | 3 | AGENTS.md discovery (24 tests) + hook registry (42 tests). §8 + §9. |
| `bebd30f` | 4a | Tool type, ToolRegistry, ModelAdapter interface, Session (22 tests). §3.2, §3.4, §10. |
| `37079cb` | 4b | read_file + bash built-in tools + Agent loop (56 tests). §3.4, §10. |
| `4d104cc` | 4c | CLI argv parser + runner + e2e (24 tests). §19. |
| `16a6bf1` | 4d | Verifier rule engine (26 tests). §12.1, §12.2. |

Total: **+24 source files, +13 test files, 263 tests.**

## How to verify locally

```sh
pnpm install
pnpm test          # 263 tests, ~1s
pnpm typecheck     # tsc --noEmit, clean
pnpm envoy --help  # shows §19 v0 flag set
pnpm envoy --version
```

## Design alignment

Phase 1 milestone from `docs/design.md` §22:

> All file skeletons exist; the 6 bash validators are real; the
> AGENTS.md discovery is real; the hook registry is real; the
> verifier rule engine is real; the agent loop runs; the CLI
> takes a prompt and returns a response.

**All seven items are done.**

Tests:
> Parity test for the 6 bash validators, AGENTS.md discovery,
> hook events, agent loop on a mock model.

**All four items are done.**

## Architectural invariants (per §4)

- **Zero EnvoyMesh-internal deps** — Package 1 (this branch) has
  no `import` from `@envoymesh/*`. Adapter (Package 3) is the
  bridge. Per design target #2/#4.
- **Capability seams complete** — every concept (bash validation,
  hooks, tools, model, session) has Service Definition / Provider
  / Consumer roles. Per glossary.
- **Local types mirror wire types** — `Verdict`, `VerifierSource`,
  `SkillId`, `AgentRuntime` are defined locally and match the
  wire values verbatim. Adapter (Package 3) translates.
- **`exactOptionalPropertyTypes: true`** respected throughout.
- **Tree-shakable runners** — `runShellHandler` / `runModuleHandler`
  are dynamic-imported only when a declarative `HookHandler` is
  registered.
- **Test isolation** — every test gets a fresh `HookRegistry` /
  `ToolRegistry` / `Session`. `FakeModel` snapshots its input so
  test assertions don't see later mutations.

## What's NOT in this branch (intentional)

- **Real model adapters** (OpenAI / Anthropic / DeepSeek) — the
  `ModelAdapter` interface is here; real providers land in a
  separate `llm` package (Phase 2 / beyond). The bin script
  throws with a useful message if no adapter is wired.
- **Self-evolution 5-step protocol** (§13) — separate concern,
  planned for the next branch.
- **Persistence (--resume, --fork)** — `--resume` and `--fork`
  are accepted in argv but not wired. Phase 2 (mesh-native)
  introduces `$ENVOY_HOME/sessions/`.
- **JSON Lines streaming, REPL, slash commands** — `--json` is
  accepted, `--quiet` works; the rest is single-shot for v0.

## Risk areas to look at

1. **`policyFromMode` duplication** — the bash tool
   (`src/tools/builtin/bash.ts:46`) and the agent
   (`src/agent.ts`) independently derive `SandboxPolicy` from
   the session's permissionMode. They MUST stay in sync. If you
   change one, change the other. Consider extracting a single
   helper in a follow-up.
2. **`defaultRegistry` is module-level state** — used in
   `HookRegistry`'s default and exposed publicly. Tests don't
   touch it (they use `new HookRegistry()` per test), so no
   pollution risk in v0. The convention is documented in the
   `defaultRegistry` JSDoc.
3. **`abort()` semantics** — calling `Agent.abort()` while a
   model call is in flight does NOT cancel the in-flight call
   (we don't have a stream-cancel protocol yet). The current
   iteration finishes, then the loop checks the flag and exits.
   Streaming cancellation is a v0+ concern.
4. **`FakeModel` test fixture** — `test/fixtures/fake-model.ts`
   is not in the public API. Real model adapters (Phase 2)
   belong in a separate `llm` package.

## Review focus

- `src/agent.ts` — the 5-step loop (per design §3.4). Pay
  attention to the order: model → assistant msg → extract
  tool_calls → for each: PreToolUse → arg validation →
  execute → PostToolUse → tool result. Loop until no tool
  calls or abort.
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
  checks; thorough arg-vs-policy cross-referencing is Phase 2
  (needs cost-tracking data to bound). `cost-reasonable-for-work`
  abstains (no metrics in v0).

## Phase 2 preview

- `envoy-harness-adapter` (Package 3): MAP protocol translation
  + sub-agent dispatch.
- `llm` package: real adapters (OpenAI / Anthropic / DeepSeek).
- Cost tracking (§14) — needed for the verifier's
  `cost-reasonable-for-work` rule to be useful.
- Persistence — sessions, hooks.toml, verifier-rules.json under
  `$ENVOY_HOME/`.

Closes the Phase 1 v0 spine milestone per `docs/design.md` §22.
