# Implementation plan — Phase B / Item 3.2 (more sample plugins)

> **Source:** [`gap-closure-plan.md`](./gap-closure-plan.md) (item 3) +
> [`implementation-plan-chunk-3-1.md`](./implementation-plan-chunk-3-1.md)
> (the seam, which this chunk extends with two more samples).
>
> **Reference:** deepseek's `@deepseek-ai/dsh-hooks-codex`
> + `@deepseek-ai/dsh-skill` (sample plugin shapes).
>
> **Scope:** two more built-in sample plugins that
> exercise different facets of the seam from chunk 3.1:
>
> - **`confirm-tool`** — a hook plugin. Registers a
>   `PreToolUse` handler that returns `ask` for the
>   `bash` tool, forcing the user to confirm every
>   bash invocation. Demonstrates: `match.tool`
>   filtering, the `ask` decision (F9.1's
>   `AskDecision` host wire), config-driven behavior.
> - **`calculator`** — a tool plugin. Registers a
>   `calculator` tool on `ctx.tools`. The tool takes
>   `{ expression: string }` and returns the evaluated
>   result. Demonstrates: tool registration, the
>   `ToolRegistry.register` path, the `Tool` interface.
>
> **Out of scope (chunks 3.3, 3.4):**
> - **3.3** — Per-plugin config via `--plugin-config key=value`
>   (v0 plugins run with an empty config; chunk 3.3
>   wires per-plugin configs from the CLI).
> - **3.4** — `Config: z.ZodSchema<Config>` for typed
>   per-plugin configs (v0 plugins use `unknown`
>   configs internally; chunk 3.4 adds the schema path).
> - A "fragment" plugin (would need `ctx.fragments` —
>   not in v0's `CapabilityContext`; lands when the
>   bounded-fragment subsystem ships in a later
>   phase).
>
> **Status:** plan locked at 2026-08-21; awaiting sign-off.

## Why this chunk

Chunk 3.1 shipped the capability-module seam + the
smallest possible sample (the `audit-log` plugin).
The seam works, but it has only one sample — the
seam is "tested but not exercised". Chunk 3.2 ships
two more samples that exercise:

1. **A `PreToolUse` hook with `match.tool` filtering**
   — proves that hook registration on `ctx.hooks`
   works for any of the 12 hook events (not just
   `PostToolUse`), and that `match.tool` actually
   filters.
2. **The `ask` decision** — proves that the
   `HookDecision.ask` path (the F9.1 `AskDecision`
   host wire) works end-to-end through the plugin
   seam. The `audit-log` plugin never returns `ask`
   (it just logs); `confirm-tool` is the first
   real "user interaction" plugin.
3. **A tool registration on `ctx.tools`** — proves
   that the `ToolRegistry.register` path works for
   plugins, and that the model can see plugin-
     registered tools on the next turn.
4. **Config-driven behavior** — proves that
   `apply(ctx, config)` is a real seam: a plugin
   can read its config and behave differently
   based on it (the `confirm-tool` has a `tool?`
   config; the `calculator` has a `precision?`
   config).

Two more plugins + their tests = a real exercise
of every facet of the seam.

## Design choices (locked at chunk start)

### 1. `confirm-tool` filters by tool name (manual filter inside the handler)

The plugin's `apply` registers a `PreToolUse` handler
as a `HookFn` (function). The handler reads
`event.payload.tool` and compares it against
`config.tool ?? "bash"`. The default tool is `"bash"`
(the most common case for "needs confirmation"). A
user can change the tool via config (e.g. to ask for
`read_file` instead).

**Why manual filter, not `match.tool` on the
registry:** the `HookRegistry.on()` API takes
`HookFn | HookHandler` (see `src/types.ts:212`); the
declarative `HookHandler.match` is only honored for
shell-command / TS-module handlers, not for
inline `HookFn` calls. A `HookFn` that wants to
filter by tool name must inspect the payload itself.
The `confirm-tool` plugin does this — it's the
canonical pattern for "filter, then act".

**Why `ask` (not `block`):** the `ask` decision
hands control to the host's `askHandler`, which
prompts the user. The user can allow / deny. This
is the "permission request" semantic in codex /
claudecode / deepseek. The `block` decision would
auto-deny, which is more aggressive than the user
asked for.

### 2. `calculator` uses a simple expression evaluator

The tool's `invoke` calls a small expression
evaluator. v0 supports `+`, `-`, `*`, `/`, `(`, `)`,
and integer / decimal literals. No variables, no
functions, no exponentiation — the v0 evaluator
is intentionally tiny (the chunk's goal is to
prove the tool-registration path, not to ship a
calculator).

**Why the `precision?` config:** real calculators
round; a user might want 2 decimal places for
currency, or 10 for scientific notation. v0
exposes `precision` as a config so the user can
tune the output. Default: 6 decimal places
(matches JavaScript's `Number.prototype.toFixed`
default for non-integer cases).

**Why a tool, not a hook:** the calculator is a
user-facing capability ("the model can ask
`calculator(2 + 2)` to get `4`"). Hooks are
side-effect-y (they intercept events); tools are
direct calls (the model calls them when it needs
the answer). Different shape, different example.

### 3. Both plugins are added to `PLUGIN_WHITELIST` (and the built-in map)

The whitelist grows from 1 entry to 3. The
security boundary is unchanged (the user still
can't load arbitrary modules without explicit
whitelist entries); the curated list just
expanded.

**Why not make them opt-in:** chunk 3.1 is the
"hardened seam" — the whitelist is a security
boundary. Adding more curated samples to the
list is the natural way to grow the plugin
ecosystem; users don't opt into each one
individually. (A future chunk can add per-plugin
opt-in if the use case emerges.)

**Built-in map (the loader short-circuit):** the
built-in samples ship INSIDE this package
(`src/plugins/builtin/*.ts`). A dynamic
`import("envoy-harness-plugin-audit-log")`
would fail at runtime because there's no
`node_modules/envoy-harness-plugin-audit-log/`
to resolve. The loader checks the whitelist
first; if the name is in the whitelist AND in
the new `BUILTIN_PLUGINS` map
(`src/plugins/whitelist.ts`), the loader
returns the module directly (no dynamic
import). The dynamic import is reserved for
external plugins (a future chunk can ship
`@scope/envoy-harness-plugin-foo` as a
separate package).

The `BUILTIN_PLUGINS` map is a
`Map<string, CapabilityModule<unknown>>`
populated statically at module-load time. The
map co-exists with the `WHITELIST` set: the
whitelist is the security gate, the map is the
data for the built-in names. Adding a new
built-in means: (1) add the module file under
`builtin/`, (2) add the name to the whitelist
set, (3) add the entry to the map.

### 4. Config is still `unknown` (chunk 3.4 will add the schema path)

v0 plugins read their `config` parameter and cast
it to the expected shape. There's no zod schema
in v0. The `confirm-tool` plugin does
`config?.tool ?? "bash"` (with `as { tool?: string }`).
The `calculator` plugin does
`config?.precision ?? 6` (with `as { precision?: number }`).

**Why the cast:** TypeScript's structural typing
lets us treat `unknown` as the expected shape
when the plugin author has documented the shape.
The cast is a "trust the plugin author" contract
(same as the deepseek `apply` contract — the
config schema is the plugin's responsibility).
Chunk 3.4 adds the zod schema path for plugins
that want the runtime validation.

## Files

### New

- `src/plugins/builtin/confirm-tool.ts` — the
  `PreToolUse` ask-on-bash sample. ~115 LoC.
- `src/plugins/builtin/calculator.ts` — the
  `calculator` tool sample + the small
  expression evaluator. ~349 LoC (the
  evaluator is ~150 LoC alone; the chunk's
  goal is to prove the tool-registration
  path, not to ship a calculator).
- `test/plugins/builtin/confirm-tool.test.ts` —
  hermetic. ~121 LoC, 5 tests.
- `test/plugins/builtin/calculator.test.ts` —
  hermetic. ~175 LoC, 10 tests.
- `test/plugins/loader-builtins.test.ts` —
  exercises the production `loadPlugin` path
  on the three built-in samples. ~3 tests.

### Modified

- `src/plugins/whitelist.ts` — add the 2 new
  entries; add the `BUILTIN_PLUGINS` map +
  `isBuiltinPlugin` + `getBuiltinPlugin`
  helpers. ~30 lines added.
- `src/plugins/loader.ts` — short-circuit the
  dynamic import for built-in names
  (checks `isBuiltinPlugin` first).
  ~20 lines added.
- `src/plugins/index.ts` — re-export the 2
  new plugins + the new built-in helpers.
  ~5 lines.
- `src/index.ts` — re-export the 2 new
  plugins + the new built-in helpers. ~5 lines.
- `test/plugins/whitelist.test.ts` — add the
  new entries + the new built-in helpers.
  +6 tests.
- `test/plugins/loader.test.ts` — update the
  comment to point at the new built-in
  loader test.
- `test/plugins/registry.test.ts` — fix the
  pre-existing `() => undefined` not
  assignable to `Disposable` (the new
  TypeScript strictness caught it; the test
  helper now uses `const dispose: Disposable
  = () => undefined`).
- `test/plugins/builtin/audit-log.test.ts` —
  no changes.

### Untouched

- `types.ts` — the new plugins use the same
  `CapabilityModule` contract.
- `registry.ts` — the new plugins use the
  same `PluginRegistry` lifecycle.
- The `Agent` class — the host still owns
  the plugin wiring.
- The CLI flags — the new plugins are
  loaded by the same `--plugin <name>` flag
  as the audit-log sample. No new flags in
  v0 (per-plugin config lands in chunk 3.3).

## Test plan (hermetic)

### `confirm-tool.test.ts` (5 tests)

- Registers a `PreToolUse` hook on apply.
- The hook returns `ask` for the default
  target (`bash`) with the standard
  "Allow / Deny" options.
- The hook returns `continue` for a
  non-matching tool name (the manual filter
  works).
- A custom target via `config.tool`
  overrides the default.
- The returned `Disposable` unregisters the
  handler (no more `ask` decisions after
  dispose).

### `calculator.test.ts` (10 tests)

**`evaluateExpression` (5 tests, pure):**

- Basic arithmetic (`+`, `-`, `*`, `/`).
- Operator precedence (`*` / `/` bind
  tighter than `+` / `-`).
- Unary minus (e.g. `-5 + 10`).
- Decimals and chained operations
  (`0.1 + 0.2 ≈ 0.3`, `1.5 * 2 + 1 = 4`).
- Throws `CalculatorError` on invalid
  input (empty expr, unmatched paren, bad
  char, division by zero).

**`calculatorPlugin` (5 tests, hermetic):**

- Registers the tool on `ctx.tools` after
  `apply`.
- `calculator.invoke({ expression: "2 + 2" })` →
  `{ result: "4.000000" }` (default precision).
- `calculator.invoke({ expression: "1 / 3" })` →
  `{ result: "0.333333" }` (1/3 at 6 dp).
- Custom precision: `{ precision: 2 }` →
  `1/3` rounds to `{ result: "0.33" }`.
- The returned `Disposable` unregisters the
  tool (no `calculator` in the registry after
  dispose).

### `loader-builtins.test.ts` (3 tests)

- `loadPlugin("envoy-harness-plugin-audit-log")`
  returns the same `auditLogPlugin` reference
  (the built-in short-circuit works).
- `loadPlugin("envoy-harness-plugin-confirm-tool")`
  → same `confirmToolPlugin` reference.
- `loadPlugin("envoy-harness-plugin-calculator")`
  → same `calculatorPlugin` reference.

### `whitelist.test.ts` (+6 tests)

- The new entries (confirm-tool, calculator)
  are in the whitelist.
- `isBuiltinPlugin` returns `true` for the
  built-in names and `false` otherwise.
- `getBuiltinPlugin` returns the module for
  a built-in name; `undefined` otherwise.

## Module-size check

- `confirm-tool.ts` 115 LoC (under target).
- `calculator.ts` 349 LoC (under target;
  the expression evaluator is the bulk).
- `loader.ts` grew by ~20 LoC (currently 154;
  → 174, still under target).
- `whitelist.ts` grew by ~30 LoC (currently 56;
  → ~110, still under target).
- The 3 test files together ~340 LoC (under
  target each).

No new allowlist entries.

## Success criteria

- A user can run
  `envoy --plugin envoy-harness-plugin-confirm-tool "do X"`.
- The `confirm-tool` plugin registers a `PreToolUse`
  hook that returns `ask` for `bash` tool calls.
- A user can run
  `envoy --plugin envoy-harness-plugin-calculator "do X"`.
- The model can call the `calculator` tool; the
  result is a number string.
- Both plugins are added to the whitelist; the
  existing test suite continues to pass.
- All existing 1312 tests still pass.
- New tests: +24 (5 confirm-tool + 10 calculator +
  3 loader-builtins + 6 whitelist = 24). Total:
  1336 passing tests.
- Module-size check: no new file exits the
  allowlist.
- `loadPlugin("envoy-harness-plugin-foo")` for
  any of the 3 built-in names returns the
  module directly (no dynamic import; the
  built-in short-circuit works).

## Out of scope (future chunks)

- **Chunk 3.3** — Per-plugin config via
  `--plugin-config <name>.<key>=<value>` (the
  deepseek-style scoped dot format). v0
  plugins receive an empty `{}` config; this
  chunk adds the CLI path. The calculator +
  confirm-tool plugins can then be
  configured (e.g.
  `--plugin envoy-harness-plugin-calculator
  --plugin-config envoy-harness-plugin-calculator.precision=2`).
- **Chunk 3.4** — `Config: z.ZodSchema<Config>`:
  plugins can export a zod schema in their
  default export; the loader validates the
  config against it before calling `apply`.
  The audit-log + confirm-tool + calculator
  plugins get real schemas in this chunk.
- **A "fragment" plugin** — would need
  `ctx.fragments` (a new facet on the
  `CapabilityContext`). Not in v0's
  `CapabilityContext`; lands when the bounded-
  fragment subsystem ships in a later phase.
- **Plugin docstring / type-only imports** — the
  built-in plugins would benefit from JSDoc on the
  `CapabilityModule` type (TypeScript language
  server picks it up). v0's JSDoc is minimal;
  future chunk adds the full type-only API doc.
