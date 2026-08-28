# Implementation plan — Phase B / Item 15.2 (deepseek hook bridge + JSON-RPC codec)

> **Source:** [`gap-closure-plan.md`](./gap-closure-plan.md) (item 15) +
> [`implementation-plan.md`](./implementation-plan.md) ("Phase B —
> Runtime extensibility", chunk 15.2) +
> [`implementation-plan-chunk-15-1.md`](./implementation-plan-chunk-15-1.md)
> (the codex importer that this chunk extends).
>
> **Reference:** `deepseek-harness/packages/hooks/hook-protocol`
> (the `parseHookOutput` codec + `CommandHook` / `MatcherGroup`
> types) + `packages/hooks/hooks-claude-code` (the CC bridge's
> `parseClaudeCodeConfig` + the `substituteCommand` var
> substitution).
>
> **Scope:** this chunk ships (a) a deepseek `cordis.yml`
> importer that finds hook plugin entries + (b) a JSON-RPC
> bridge for the resulting `HookHandler[]`, with the deepseek
> codec (exit 2 → block, `permissionDecision`, `additionalContext`)
> folded into the existing `runShellHandler`. Codex `[hooks]`
> support lands in a future chunk (the codex importer is
> already shipped; adding `[hooks]` is additive).
>
> **Status:** plan locked at 2026-08-21; awaiting sign-off.

## Why this chunk

Chunk 15.1 ships the codex `ConfigLayer` (permission + sandbox)
import. Without hooks, a user migrating from codex/deepseek
loses their existing hook config — and hooks are the
highest-value piece of the user-facing surface (audit logging,
custom `PreToolUse` decisions, `PostToolUse` context injection,
etc.).

This chunk closes the loop:

1. **`cordis.yml` importer** — reads a deepseek-style
   `cordis.yml`, finds hook plugin entries, reads the
   referenced `configPath` (e.g. `.claude/hooks.json`),
   extracts the `MatcherGroup[]` for each event.
2. **JSON-RPC bridge** — the resulting hooks are registered
   on the agent's `HookRegistry`. The existing `runShellHandler`
   already spawns a shell + parses stdout JSON; this chunk
   extends it with the deepseek codec so a hook can express
   `permissionDecision: "ask"` or `additionalContext` (CC) /
   `PreToolUse` results.
3. **CLI surface** — `--from deepseek-cordis` joins `--from codex`
   in the importer format list. Same `--import-config <path>`
   flow.

## Design choices (locked at chunk start)

### 1. `ConfigLayer` gets a new `hooks` field

The schema gains a single new field:

```ts
hooks?: HookHandlerSpec[]  // mapped from `[[hooks]]` in TOML
```

`HookHandlerSpec` is a frozen-shape subset of the existing
`HookHandler` (the one the runtime `HookRegistry` accepts):
`{ command, match, timeoutMs }` — we strip the `module` form
(deepseek's bridges are command-only; the `module` form is
envoy-native and is still accepted when the user writes an
envoy-harness config directly).

**Why a new `HookHandlerSpec` type, not the runtime `HookHandler`:**
the runtime type has `command?: string` + `module?: string`
(OR). The config layer needs the *same* shape but with
`command: string` (the `module` form isn't valid in a TOML
file — the user has to write code, not config). Splitting the
types keeps both clean: the schema validates the config; the
runtime uses what the config produces.

**Why an array, not a single table:** the runtime registers
one handler per `on(event, handler)` call. Each matcher group
becomes one registration; each command in the group becomes a
separate registration (envoy's `HookRegistry` composes
multiple handlers on the same event). The flat list is the
natural shape.

### 2. cordis.yml parsing is hand-written (the format is a simple list)

deepseek's `cordis.yml` is a YAML list of plugin entries. Each
entry has `id`, `name`, optional `config`, optional `disabled`.
A hook plugin is one whose `name` matches `dsh-hooks-*`
(typically `@deepseek-ai/dsh-hooks-claude-code` or
`@deepseek-ai/dsh-hooks-codex`). The `config` field has the
bridge-specific options (e.g. `configPath`, `pluginRoot`,
`projectDir`).

We use the existing `yaml` dep (already in `package.json`
for the schema-side; added for the importer). The parser walks
the list, filters by name pattern, and for each match delegates
to the bridge-specific importer (`claude-code.ts` in v0; future
chunks add `codex`, `gemini`, etc.).

**Why not import the actual `@deepseek-ai/dsh-hooks-claude-code`
package:** it's cordis-coupled (it expects a Cordis `Context`
+ `ctx.shell`). envoy-harness is cordis-free (per the
gap-closure "do not adopt Cordis as a platform" rule). The
port re-implements the parsing logic in ~100 LoC.

### 3. v0 supports only the Claude Code bridge

The CC bridge is the most common (and most-documented)
deepseek hook bridge. Supporting it is enough to ship chunk
15.2; the codex bridge lands in chunk 15.3 (it requires the
codex `[hooks]` table to also be in the codex importer, which
chunk 15.1 deferred).

**Future-bridge design:** the importer's bridge dispatch
returns the same `HookHandlerSpec[]` shape regardless of which
bridge produced it. Adding a new bridge is one new file
(`hooks-gemini.ts` etc.) + one new entry in the bridge registry.
The `cordis.yml` importer doesn't need to change.

### 4. JSON-RPC bridge: extend `runShellHandler` (don't fork it)

The existing `runShellHandler` already does 80% of the work:
spawn `sh -c "$command"`, pass event payload via env vars,
parse stdout JSON, map to a `HookDecision`. The deepseek
codec adds three behaviors:

1. **Exit 2 → block with stderr as the reason** (the deepseek
   convention; we currently treat *any* non-zero as block,
   which is too coarse).
2. **`permissionDecision`** (`allow` / `deny` / `ask`) in the
   parsed JSON maps to `continue` / `block` / `ask` (envoy
   has `ask` for `PreToolUse`; it maps to the
   `PreToolDecision.ask` shape via the existing
   `HookDecision.ask` variant).
3. **`additionalContext`** maps to `add-context` (CC's
   pre-step / post-step / session-start hook).

**Why extend, not fork:** the existing runner is the canonical
place. A new runner would be a divergence the next reader has
to reconcile. The extensions are additive (new fields on the
parsed JSON, new exit-code behavior) and the tests pin them
explicitly.

### 5. Hook registration happens at the runner, not at `loadConfig`

The config layer carries `hooks: HookHandlerSpec[]`. The
runner reads the layer + registers each spec on the agent's
`HookRegistry`. The registration is done after the agent is
constructed (so the registry exists) but before the agent
runs (so the hooks are live for the first turn).

**Why not register at load time:** the registry is per-agent;
the config layer is per-process. A single config file should
be able to drive multiple agents (e.g. parallel sub-agents
that share config but get separate hook instances).

**Why a separate helper (`registerHooksFromConfig`):** the
runner already has 6 inline `agentOptions.X = …` lines. A
named helper makes the integration testable in isolation
(register a spec, fire an event, assert the spec ran).

## Files

### New

- `src/config/import/claude-code.ts` — `parseClaudeCodeHooks(path, vars)`
  → `HookHandlerSpec[]`. Port of `parseClaudeCodeConfig` from
  deepseek's `hooks-claude-code` package (the parts that
  don't depend on Cordis). ~100 LoC.
- `src/config/import/deepseek.ts` — `importDeepseekConfig(path)`
  → `ConfigLayer`. Reads `cordis.yml`, finds hook plugins,
  delegates to the bridge importer, accumulates the
  `HookHandlerSpec[]`. ~120 LoC.
- `src/hooks/register-from-config.ts` — `registerHooksFromConfig(
  registry, specs)` → registers each spec on the registry.
  Idempotent (clears any previously-registered spec when called
  again). ~50 LoC.
- `test/config/import-claude-code.test.ts` — ~8 tests.
- `test/config/import-deepseek.test.ts` — ~10 tests.
- `test/hooks/register-from-config.test.ts` — ~4 tests.
- `test/hooks/runner-codec.test.ts` — deepseek codec extensions
  (~6 tests).

### Modified

- `src/config/schema.ts` — add `hooks: HookHandlerSpec[]`
  field + the `HookHandlerSpec` type. ~25 lines.
- `src/config/loader.ts` — update `mapKebabToCamel` to handle
  the `hooks` array (the existing mapper does a shallow
  switch; we add the new key). + update `loadConfigWithImport`
  to surface the `hooks` field. ~10 lines.
- `src/config/import/index.ts` — add `deepseek-cordis` to
  `SUPPORTED_IMPORT_FORMATS` + re-export the new symbols.
- `src/index.ts` — re-export the new symbols.
- `src/hooks/runner.ts` — extend `runShellHandler` with the
  deepseek codec (exit 2, `permissionDecision`,
  `additionalContext`). The change is additive; the existing
  v0 test suite continues to pass (the new behavior is gated
  on the structured-stdout shape). ~40 lines.
- `src/hooks/types.ts` (or wherever `HookHandler` lives) —
  add the `HookHandlerSpec` type (or just use `HookHandler`
  with a runtime check; the spec-from-config IS a
  `HookHandler` minus `module`). TBD based on what reads
  cleanest; preference: add the spec type separately.
- `src/cli/run/one-shot.ts` — call `registerHooksFromConfig`
  after the agent is constructed when `configLayer.hooks` is
  non-empty. ~10 lines.
- `test/config.test.ts` — extend with a `hooks` field test
  (~2 tests: round-trip + unknown field rejection).

### Untouched

- The codex importer (chunk 15.1). Adding `[hooks]` support is
  a future chunk (15.3+).
- The existing `runShellHandler` behavior for non-deepseek
  hooks (CC exit 0, plain stdout, etc.) — the extensions are
  gated on the parsed JSON shape.

## Test plan (hermetic)

### `import-claude-code.test.ts` (~8 tests)

- A real-world CC hooks.json sample (from
  `examples/acp-agent/tests/snapshots/hook-cc-stop-continue/.../hooks.json`)
  → translated to `HookHandlerSpec[]`.
- A `PreToolUse` with `matcher: "bash"` → `match.tool = "bash"`.
- A `Stop` (no matcher) → `match` undefined.
- Non-command hooks (`http`, `prompt`, `agent`) → skipped
  + a warning.
- A `command` with `${CLAUDE_PLUGIN_ROOT}` and
  `${CLAUDE_PROJECT_DIR}` → substituted.
- A missing `configPath` file → `ConfigLoadError` (the user
  asked for THIS bridge).
- A malformed JSON file → `ConfigLoadError`.
- An unknown event name → ignored (the runner doesn't know
  about it, but the parser still produces valid output).

### `import-deepseek.test.ts` (~10 tests)

- A real-world cordis.yml sample (the SDK's
  `cordis.yml` from `python/sdk-runtime/.../cordis.yml`)
  → hooks extracted, native plugins ignored.
- A `dsh-hooks-claude-code` entry → delegates to the CC
  importer; result lands in `layer.hooks`.
- A `dsh-hooks-codex` entry (future bridge) → ignored with a
  warning ("not in v0").
- A non-hook plugin (e.g. `dsh-llm-deepseek`) → ignored
  silently (not a hook).
- A hook plugin with `disabled: true` → ignored.
- A `cordis.yml` with no hook plugins → `layer.hooks` is
  undefined; no warnings.
- A `cordis.yml` with multiple hook plugins → all are
  processed; conflicts in event names produce a warning.
- A malformed YAML file → `ConfigLoadError`.
- A `cordis.yml` with `!js` tags (deepseek's `!!js process.env.X`)
  → error (we don't support JS expressions; the user must
  use the native `--from codex` or write a TOML config).
- A `cordis.yml` that references a relative `configPath` →
  resolved relative to the cordis.yml's directory (not the
  process cwd).

### `register-from-config.test.ts` (~4 tests)

- Registers a `PreToolUse` spec → fires the event → the spec's
  command runs.
- Two specs for the same event → both run (composition).
- A spec with `match.tool: "bash"` → fires only on `bash`
  tool calls.
- Re-registering replaces the previous registration (idempotent).

### `runner-codec.test.ts` (~6 tests)

- Exit 2 + empty stderr → `block` with reason `"hook exited 2"`.
- Exit 2 + non-empty stderr → `block` with reason = stderr.
- Exit 0 + `{permissionDecision: "deny"}` → `block` with the
  reason.
- Exit 0 + `{permissionDecision: "allow"}` → `continue`.
- Exit 0 + `{permissionDecision: "ask"}` (on PreToolUse) →
  `ask` with the reason.
- Exit 0 + `{hookSpecificOutput: {additionalContext: "..."}}` →
  `add-context`.

## Module-size check

- `import/claude-code.ts` ~100 LoC (well under target).
- `import/deepseek.ts` ~120 LoC (under target).
- `hooks/register-from-config.ts` ~50 LoC (small).
- `schema.ts` grows by ~25 LoC.
- `runner.ts` grows by ~40 LoC (currently ~217, → ~257,
  still under target).
- `one-shot.ts` grows by ~10 LoC.

No new allowlist entries needed.

## Success criteria

- A user with a `cordis.yml` referencing
  `@deepseek-ai/dsh-hooks-claude-code` can run
  `envoy --import-config cordis.yml --from deepseek-cordis`
  and the agent honors their `PreToolUse` /
  `PostToolUse` / `Stop` hooks.
- A CC hook emitting `{permissionDecision: "ask"}` results
  in an `ask` decision (the existing `askHandler` flow).
- A CC hook emitting `additionalContext` shows up in the
  model context (via the existing `add-context` decision).
- The deepseek codec refinements (exit 2, permissionDecision,
  additionalContext) are additive — the existing v0 test suite
  (no structured stdout) still passes unchanged.
- All existing 1248 tests still pass.
- New tests: ~30.
- Module-size check: no new file exits the allowlist.
- `SUPPORTED_IMPORT_FORMATS` now lists `["codex",
  "deepseek-cordis"]`.

## Out of scope (future chunks)

- **Codex `[hooks]` support** in the codex importer. The
  codex hook format (`MatcherGroup[]` per event with the
  same `command` + `matcher` shape) is close to CC's; the
  translation is mechanical but non-trivial. Future chunk
  (15.3+).
- **The Codex deepseek bridge** (`@deepseek-ai/dsh-hooks-codex`).
  Same shape as CC; lands with the codex `[hooks]` work.
- **Auto-detect** of the file format (the `--from` flag is
  still required in v0).
- **JSON-RPC over stdio** for hooks (the deepseek hooks all
  communicate via env vars + stdout, not a JSON-RPC
  connection — the codec refinements are the bridge, no
  separate protocol).
- **Hook-protocol equivalence tests** (golden transcripts of
  real hook output). Future; the codec tests in this chunk
  cover the spec.
- **Migration shim** for users with a deepseek-installed
  `cordis.yml` that uses `!!js` tags. Out of scope; the user
  must rewrite those to a TOML config or use a static value.
