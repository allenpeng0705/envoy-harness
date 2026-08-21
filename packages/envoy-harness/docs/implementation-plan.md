# Implementation plan — gap closure (Phase A)

> **Source:** [`gap-closure-plan.md`](./gap-closure-plan.md) (DRAFT v2, 2026-08-21).
> This doc is the executable sub-plan for **Phase A only** ("Loop & context",
> 1–2 weeks, items 1, 2, 5, 6). Later phases (B–G) get their own sub-plans
> when their turn comes.
>
> **Per-chunk discipline:** every chunk = one sub-plan doc + one commit.
> Locked design questions live in the chunk's sub-plan; the chunk ships
> the code + tests + a self-review commit.

## Why this doc

`gap-closure-plan.md` is the strategy: which gaps matter, in what order,
which existing packages we reuse, which standards we follow. It is
intentionally design-light — the executable chunking lives here.

## Phase A — Loop & context (1–2 weeks)

The four items that close the "powerful local agent" gap: compactions that
don't blow context, memories the model can cite, open-ended user questions,
logged plan state. All four are small, hermetic, no-mesh — they unblock the
agent's day-to-day power without touching distribution.

| # | Item | Chunks | Effort | Started | Status |
|---|---|---|---|---|---|
| 1 | Compaction variants (budget / remote-history / fallback) | C1 budget math, C2 remote-history + CLI flags | M | done | ✅ shipped (`15ad4b4`) |
| 2 | Memories (codex format + deepseek retrieval discipline) | C1 store + citations, C2 consolidation + dedup | M | done | ✅ shipped (`798f757`) |
| 5 | Ask-user / elicitation (open-ended questions) | C1 service + REPL provider, C2 tool + approval delegation | S | done | ✅ shipped (`8404c8f` + `97c7a7e` + self-review `28c7aae`) |
| 6 | Plan mode (logged collaboration state) | C1 plan state + injection + `/plan` REPL command, C2 review API handoff | S | done | ✅ shipped (pending) |

Order rationale: **5 first** (smallest, no dependencies, sets the
"interaction surface" pattern for the other items), then **1** (compaction
is the most common failure mode in real usage), then **2** (memories build
on bounded fragments from item 1's budget math), then **6** (plan state
references memory + verification results — last in the phase).

**Phase A status (as of 2026-08-21):** all 4 items shipped (item 5
fully + a self-review commit that caught a P0 shim-replacement bug;
items 1, 2, 6 each shipped as single commits). Total tests: 1218
passing + 3 live-API tests skipped (no key).

## Phase B — Runtime extensibility (in progress)

The two items that close the "extensibility" gap: a config
importer that lets hosts already on codex/deepseek drop in their
existing config files, and the capability-module seam that lets
plugins extend the harness at runtime. Chunk 15.1 (codex config
importer) is the first deliverable; chunks 15.2 (deepseek +
hook-protocol bridge) and 3.1+ (the plugin seam) follow.

| # | Item | Chunks | Effort | Started | Status |
|---|---|---|---|---|---|
| 15 | External config import (codex + deepseek) | C1 codex TOML importer, C2 deepseek + hook-protocol bridge | S–M | done | ✅ C1 + C2 shipped |
| 3 | Plugins at runtime | C1 capability-module seam, C2 sample plugins, C3 per-plugin config, C4 per-plugin zod config | L | done | ✅ C1 + C2 + C3 + C4 code + tests done (pending user commit) |

## Chunk 5.1 — ask-user service + REPL provider (shipped in `8404c8f`)

**Goal:** one `UserQuestionService` interface + a default REPL provider.
No model-facing tool yet; that's chunk 5.2. The service stands alone so
chunk 5.2's tool is a thin wrapper + the existing approval flow can
delegate to it (item 5 design — "approval and ask_user share the service
so the human has a single interaction surface").

**Files (`src/interaction/`):**
- `user-questions.ts` — `UserQuestionRequest`, `UserQuestionAnswer`,
  `UserQuestionService` interface + `createUserQuestionService()` factory.
  One active provider at a time; `registerProvider(p)` returns a
  disposer. `ask(req)` is `AbortSignal`-aware. Empty-provider state
  returns a synthetic "no provider" answer (the model can fall through).
- `providers/repl-stdin.ts` — the default REPL provider. Reads a single
  line from stdin (or multiple lines when `multiline: true`, terminated
  by a sentinel like `"""` on its own line). `cancelled` mapping: EOF
  or `Ctrl+C` (when `signal` aborts) → `{ value: "", cancelled: true }`.
  The provider logs the answer to the REPL output so the user sees
  the echo.
- `index.ts` — re-export the public surface.

**Wire-up (minimal):** the Agent's constructor takes a new optional
`userQuestions?: UserQuestionService` field. When absent, no provider
is registered (chunk 5.2's tool + approval-delegate callsites fall
through to "no provider" answers). This keeps chunk 5.1 additive — no
existing Agent construction site needs to change.

**Tests (hermetic — no real stdin):**
- `providers/repl-stdin.test.ts` — fake `readline`-like interface
  (inject a `Readable` + capture `write` calls). Tests:
  - Single-line prompt → user types "yes" → answer `{ value: "yes" }`
  - EOF before answer → answer `{ value: "", cancelled: true }`
  - `signal.abort()` mid-prompt → answer `{ value: "", cancelled: true }`
  - Multiline mode: type 3 lines + `"""` sentinel → joined value
  - Multiline mode: EOF before sentinel → `cancelled: true`
  - `options: ["yes", "no"]` → user picks index 1 → `{ value: "no", optionIndex: 1 }`
- `user-questions.test.ts`:
  - No provider registered → `ask()` returns `{ value: "", cancelled: true }`
    (no throw; the model falls through to its default)
  - One provider registered → `ask()` delegates
  - Register → unregister → `ask()` returns no-provider answer
  - Register a second provider → throws (one-active-provider invariant)
  - `signal` already-aborted → `ask()` returns `cancelled: true` without
    delegating

**Hermetic contract:** every test uses a fake `Readable`/`Writable` pair
(pass `process.stdin`-shaped streams to the REPL provider's
constructor; default to a `Readable.from([])` + `Writable` that pushes
into an array). No real process, no real LLM, no live kernel.

**Module-size check:** new files land under the 500-line target. The
REPL provider is the biggest (~150 LoC); keep it under by extracting
the "options picker" prompt into a small helper if it grows.

**Out of scope (chunk 5.2):**
- `ask_user` model-facing tool
- Approval flow delegating to the service
- Tauri / mesh provider (adapter package, later)
- `/plan` command (item 6)

## Chunk 5.2 — ask_user tool + approval delegation (shipped in `97c7a7e` + self-review `28c7aae`)

**Goal:** wire the model-facing `ask_user` tool + the existing
`AskForApproval` flow into the same `UserQuestionService`. The human
sees one interaction surface — the REPL provider renders both "tool
needs your input" and "tool wants to do X, allow?" the same way.

**Design choices (locked at chunk start):**
- Approval delegation: `AskForApproval` becomes a thin shim that
  translates an approval request into a `UserQuestionRequest` (the
  prompt is "Allow {toolName} to {action}? [y/N]") and returns
  `cancelled` as "deny". Backward compat: the existing `Approval`
  interface is preserved; the new path is opt-in.
- `ask_user` tool: model-facing, single-`option` or `options[]`,
  optional `multiline`, optional `timeoutMs`. When the service has
  no provider, the tool returns a structured "no user channel
  available" answer so the model knows to fall through.
- `timeoutMs`: a `setTimeout` that aborts the signal; the provider
  treats the abort as `cancelled: true`.

**Self-review catch (commit `28c7aae`):** `setUserQuestions(s2)` was
NOT replacing the auto-installed shim — the shim still closed over s1
while the `ask_user` tool closed over s2. Fixed by adding a private
`askHandlerIsShim: boolean` field tracked by the constructor +
setters. `setAskHandler(undefined)` now also restores the default
(shim if service set, else deny). 2 regression tests added.

## Later chunks (Phase A continued)

All Phase A chunks shipped. Per-chunk sub-plans:

- **Chunk 1.1 + 1.2** — compaction budget math: `selectDroppablePrefix(messages, budget)`
  + a `budget` strategy variant alongside the existing `drop-oldest`
  and `summarize` variants + `/compact --budget N` / `--remote` CLI
  flags + summarizer-throws → drop-oldest fallback. Adds
  `src/context/budget.ts` (the math) + extends
  `src/agent/compact.ts` (the strategy). See
  [`implementation-plan-chunk-1.md`](./implementation-plan-chunk-1.md).
- **Chunk 2.1 + 2.2** — `src/memories/store.ts` (codex-format
  `memories/*.md` root) + `src/memories/citations.ts` (parse /
  render `[memory:file#anchor]`) + bounded injection as
  `ContextualUserFragment`s + `consolidate.ts` (one-pass
  summarization at session end, dedup by hash) + `/memory` commands.
  See [`implementation-plan-chunk-2.md`](./implementation-plan-chunk-2.md).
- **Chunk 5.1 + 5.2** — `UserQuestionService` + REPL provider +
  `ask_user` tool + AskForApproval shim. See
  [`implementation-plan-chunk-5-2.md`](./implementation-plan-chunk-5-2.md).
- **Chunk 6.1 + 6.2** — `src/plan/state.ts` (the `PlanState` record) +
  `/plan enter/show/edit/propose/approve/reject/exit` + bounded
  injection as a top-priority fragment + `runReview` API (plan +
  result → verifier). See
  [`implementation-plan-chunk-6.md`](./implementation-plan-chunk-6.md).

## Success criteria for Phase A (local scenario parity)

- Compaction: `/compact` (drop-oldest) and `/compact --budget N`
  (budget math) and `/compact --remote` (remote-history) all work;
  fallback path triggers when the summarizer throws.
- Memories: a session writes a memory on end; the next session reads
  it as a bounded fragment with citations; codex-format memory files
  load unchanged.
- Ask-user: a model calling `ask_user` gets a real human answer (or
  a clean "no provider" fall-through); `AskForApproval` delegates to
  the same service.
- Plan: `/plan enter` opens a logged state; the plan is injected as
  a high-priority fragment; `/review` hands the plan + result to
  the verifier.
- All hermetic: no mesh, no network, no live LLM, no real kernel
  in tests. Module-size CI stays green. `pnpm test` runs in < 30s.

## Progress timeline (chronological)

Time-ordered list of what's been done across the phases. The
"shipped" rows are commits already on `fix_gaps`; the "in
flight" rows are chunks in design / build right now; the
"queued" rows are the next deliverables in the order the
gap-closure plan calls for.

### 2026-08-21 — Phase A complete; Phase B chunk 15.1 in design

| When | Chunk | Status | Commit | Notes |
|---|---|---|---|---|
| 2026-08-21 | item 5 chunk 1 (UserQuestionService + REPL provider) | shipped | `8404c8f` | Service + REPL stdin provider; 40 tests. |
| 2026-08-21 | item 5 chunk 2 (ask_user tool + AskForApproval shim) | shipped | `97c7a7e` | Tool + shim; 40 tests. |
| 2026-08-21 | item 5 chunk 2 self-review | shipped | `28c7aae` | **P0 shim-replacement fix** + safer `summarizeArgs` (truncate long bash commands). 2 regression tests. |
| 2026-08-21 | item 1 chunks 1.1 + 1.2 (budget compaction + CLI flags) | shipped | `15ad4b4` | `selectDroppablePrefix` + `/compact --budget N` + `/compact --remote` stub. 29 tests. |
| 2026-08-21 | item 2 (memories) | shipped | `798f757` | LocalMemoryStore + citations + consolidation + `/memory` REPL command. 57 tests. |
| 2026-08-21 | item 6 (plan mode) | pending | — | `/plan` REPL command + `runReview` API + 42 tests (state 16 + inject 8 + review 6 + repl-plan 12). Chunk ships with the user commit. |
| 2026-08-21 | item 15 chunk 1 (codex config importer) | pending | — | Code + tests done; 30 new tests pass (24 import-codex + 5 cli + 1 in-process); 1248 total. Plan: [`implementation-plan-chunk-15-1.md`](./implementation-plan-chunk-15-1.md). |
| 2026-08-21 | item 15 chunk 2 (deepseek cordis + CC hooks.json + deepseek codec) | pending | — | 37 new tests (12 claude-code + 11 deepseek + 4 register-from-config + 8 runner-codec + 2 config hooks round-trip); 1285 total. Plan: [`implementation-plan-chunk-15-2.md`](./implementation-plan-chunk-15-2.md). |
| 2026-08-21 | item 3.1 (capability-module seam + audit-log sample) | pending | — | 27 new tests (7 loader + 10 registry + 2 whitelist + 4 audit-log + 4 CLI --plugin); 1312 total. Plan: [`implementation-plan-chunk-3-1.md`](./implementation-plan-chunk-3-1.md). |
| 2026-08-22 | item 3.2 (sample plugins: confirm-tool + calculator) | pending | — | Two built-in samples exercising different facets of the seam: `confirm-tool` (PreToolUse `ask` decision with manual tool-name filter) + `calculator` (tool plugin with a small expression evaluator). Whitelist grew 1 → 3. Added a `BUILTIN_PLUGINS` map in the loader to short-circuit dynamic imports for in-package built-ins. 24 new tests (5 confirm-tool + 10 calculator + 3 loader-builtins + 6 whitelist); 1336 total. Plan: [`implementation-plan-chunk-3-2.md`](./implementation-plan-chunk-3-2.md). |
| 2026-08-22 | item 3.3 (per-plugin config via --plugin-config) | pending | — | Repeatable `--plugin-config <name>.<key>=<value>` (the deepseek-style scoped dot format). `parsePluginConfigEntry` splits on the first dot + first equals; values are JSON-first with a string fallback. `mergePluginConfigs` collapses entries into a `Map<name, config>`. Runner passes the per-plugin config to `register(module, config, ctx)`. 19 new tests (14 config-parser + 5 CLI); 1355 total. Plan: [`implementation-plan-chunk-3-3.md`](./implementation-plan-chunk-3-3.md). |
| 2026-08-22 | item 3.4 (zod-validated per-plugin configs) | pending | — | New `configSchema?: z.ZodType<Config>` field on `CapabilityModule` (optional — v0 `unknown` config still works). New `PluginConfigError` class (distinct from `PluginLoadError` so the CLI can format a clear "config is invalid" message). `validatePluginConfig` runs `safeParse` and throws on failure. The 3 built-in plugins gained real schemas; their `apply` reads the validated `Config` (no more `as { ... }` casts). 15 new tests (validate-config); 1370 total. Plan: [`implementation-plan-chunk-3-4.md`](./implementation-plan-chunk-3-4.md). |
| 2026-08-22 | Phase C items 7+8+9 (jobs / web / terminal) | pending | — | Cordis-free L3 ports + CLI `wireEnvironmentTools`. 23 new hermetic tests. Terminal fake backend only (`node-pty` deferred). Plan: [`implementation-plan-phase-c.md`](./implementation-plan-phase-c.md). |

### Phase A totals (final)

- **4 items shipped** (item 5 in 2 chunks + a self-review; items 1, 2, 6 single-commit each).
- **158 new tests** (chunk 5.2: 40 + self-review: 2 + chunk 1: 29 + chunk 2: 57 + chunk 6: 42 — note: chunk 6 is pending the user commit but the tests are already green).
- **1218 total tests passing** + 3 live-API tests skipped (no `DEEPSEEK_API_KEY`).
- **6 commits** ahead of `origin/fix_gaps` (5 shipped + 1 pending chunk 6).

### Phase B (in progress)

- **Item 15 chunk 1 (codex config importer)** — code + 30 new tests, 1248 total passing. Awaiting user commit. The importer translates codex's TOML config shape (sandbox_mode, approval_policy, sandbox_workspace_write.{writable_roots, network_access, exclude_slash_tmp}) to envoy-harness's `ConfigLayer`. CLI flags `--import-config <path> --from <format>` (v0: only `codex`). Imported values win over the native config; CLI flags win over both. Unknown / ignored codex keys surface as a one-line warning summary (full list with `--verbose`).
- **Item 15 chunk 2 (deepseek `cordis.yml` + CC hooks.json + deepseek codec)** — code + 37 new tests, 1285 total passing. Awaiting user commit. The deepseek importer reads a `cordis.yml`, finds `dsh-hooks-*` plugin entries, and delegates to per-bridge importers (v0: Claude Code; `dsh-hooks-codex` lands with the codex `[hooks]` support in a future chunk). The Claude Code bridge parses the referenced `hooks.json` (or settings file's `hooks` key) and produces `HookHandlerSpec[]`. The deepseek codec extensions to `runShellHandler` recognize exit 2 → block (with stderr as reason), `permissionDecision` (allow/deny/ask), and `additionalContext` — the same wire format as `deepseek-harness/packages/hooks/hook-protocol`. The `ConfigLayer` schema gains a `hooks: HookHandlerSpec[]` field (the same shape the codex importer will produce in a future chunk, when the codex `[hooks]` table lands). 9 new files / 1 extended file; total 9 over the 500-line target (same as before chunk 15.2; no new offenders).
- **Item 3 chunk 1 (capability-module seam)** — code + 27 new tests, 1312 total passing. Awaiting user commit. The seam ports deepseek's `apply(ctx, config)` contract shape (NOT the Cordis runtime; we're cordis-free). The new `CapabilityContext` exposes narrow facets: `cwd`, `hooks`, `tools`, `logger` — the plugin can extend the agent, not override it. The `PluginRegistry` owns the lifecycle (apply + dispose). The curated whitelist is the security boundary (v0: 1 entry — the built-in `audit-log` sample). The built-in `audit-log` plugin is the smallest possible sample: a `PostToolUse` hook that logs every tool call. CLI flag `--plugin <name>` (repeatable) loads whitelisted plugins. The `Agent` exposes a `plugins` field for future integration (`/plugins` REPL command, sub-agent inheritance).
- **Item 3 chunk 2 (sample plugins: confirm-tool + calculator)** — code + 24 new tests, 1336 total passing. Awaiting user commit. Two built-in samples exercising different facets of the seam: `confirm-tool` (a `PreToolUse` hook with manual tool-name filtering, returns `ask` for the configured target — default `bash`); `calculator` (a tool plugin that evaluates arithmetic expressions, supports `+`, `-`, `*`, `/`, parens, unary minus, integer/decimal literals; `precision` config). Whitelist grew 1 → 3. **Self-review caught a pre-existing chunk 3.1 design issue:** the loader's dynamic `import("envoy-harness-plugin-audit-log")` would fail at runtime because the built-in names aren't real NPM package names. Fixed by adding a `BUILTIN_PLUGINS` map in the whitelist (the loader checks it first; the dynamic import is reserved for external plugins). Also fixed a pre-existing TypeScript strictness issue in `registry.test.ts` (the test helper used `() => undefined` for a `Disposable`; now uses `const dispose: Disposable = () => undefined`).
- **Item 3 chunk 3 (per-plugin config via `--plugin-config`)** — code + 19 new tests, 1355 total passing. Awaiting user commit. The deepseek-style scoped dot format: `--plugin-config <name>.<key>=<value>` (repeatable). The parser (`src/plugins/config-parser.ts`) splits on the first `.` (plugin name) + first `=` (key=value). Values are JSON-first (`JSON.parse("2")` → `2`, `JSON.parse("true")` → `true`, `JSON.parse('"foo"')` → `"foo"`); when the parse throws (e.g. unquoted `hello`), the raw value is treated as a string. `mergePluginConfigs` collapses entries into a `Map<name, Record<string, unknown>>`. The runner passes the per-plugin config to `register(module, config, ctx)`. Plugins without a `--plugin-config` entry get `{}` (the v0 contract).
- **Item 3 chunk 4 (zod-validated per-plugin configs)** — code + 15 new tests, 1370 total passing. Awaiting user commit. New optional `configSchema?: z.ZodType<Config>` field on `CapabilityModule`. New `PluginConfigError` class (distinct from `PluginLoadError` so the CLI can format a clear "config is invalid" message with the zod issue path + message). `validatePluginConfig` runs `safeParse` and throws on failure. The 3 built-in plugins gained real zod schemas; their `apply` now destructures the validated `Config` (no more `as { ... }` casts). The runner validates BEFORE `register` (fail-fast — no half-applied plugin set).

### Phase B + later (queued)

- **Phase C (items 7 / 8 / 9)** — ✅ done 2026-08-22 (pending user
  commit). Cordis-free L3 ports under `src/jobs/`, `src/web/`,
  `src/terminal/` + `wireEnvironmentTools` CLI helper. 23 new
  hermetic tests. Terminal v0 uses a fake backend (`node-pty`
  deferred). Plan:
  [`implementation-plan-phase-c.md`](./implementation-plan-phase-c.md).
  Item 13 (secrets) remains open.
- **Item 15 chunk 2** — deepseek `cordis.yml` YAML importer + JSON-RPC hook-protocol bridge. Plan TBD after chunk 15.1 ships.
- **Item 3** — capability-module seam + Cordis-compat container (3–4 chunks). The big platform piece. Lands after item 15.
- **Phase C remainder** — item 13 (secrets).
- **Phase D** — items 14a (session query), 14b (cross-machine resume), 16 (feedback), 17 (observability).
- **Phase E** — items 10 (ACP), 11 (SDK).
- **Phase F** — item 4 (OS sandbox: landlock + seatbelt).
- **Phase G** — item 12 (Tauri UI in the EnvoyMesh host) + mesh-native integrations.
