# Implementation plan — Phase B / Item 3.1 (capability-module seam)

> **Source:** [`gap-closure-plan.md`](./gap-closure-plan.md) (item 3) +
> [`implementation-plan.md`](./implementation-plan.md) ("Phase B —
> Runtime extensibility", item 3).
>
> **Reference:** `deepseek-harness` (the `apply(ctx, config)`
> contract; the `cordis` plugin lifecycle; the `L3 — Contract
> ports` rule from the gap-closure "Reuse taxonomy" section).
>
> **Scope:** this chunk ships the core **capability-module
> seam** — the types, the loader, the registry, the wiring
> into the `Agent`, and one sample plugin (the `audit-log`
> example) to prove the seam end-to-end. The deepseek
> contract shapes are PORTED (not adopted as a dep) — we
> use the same `apply(ctx, config)` shape but with
> envoy-harness's own `Context` type, not Cordis's.
>
> **Out of scope (chunks 3.2, 3.3, 3.4):**
> - **3.2** — More sample plugins (a hook plugin + a tool
>   plugin + a bounded-fragment plugin).
> - **3.3** — The curated whitelist (a security boundary:
>   only the names in the whitelist can be loaded). The
>   whitelist defaults to the built-in samples; user-added
>   plugins land in Phase G.
> - **3.4** — A `PluginConfig` schema-validated config path
>   (uses zod, not deepseek's schemastery). v0 accepts
>   `unknown` config; a future chunk adds per-plugin
>   schemas.
> - The Cordis-compat container (Phase G, not Phase B).
>
> **Status:** plan locked at 2026-08-21; awaiting sign-off.

## Why this chunk

Today, the host wires capabilities into the `Agent` by
passing `hooks`, `tools`, `lspManager`, `meshSubmitter`,
`mcpClients`, etc. as `AgentOptions` fields. This works
for one-off integrations (the Tauri host wires its own
`lspManager`), but it's a **closed list** — third parties
can't add new capability types without modifying the
harness core.

The capability-module seam closes the loop: a third
party writes a small TypeScript module that exports
`apply(ctx, config)`, the host loads it via
`loadPlugin(modulePath)`, and the plugin registers its
hooks / tools / fragments on `ctx` (the `CapabilityContext`).
The harness core doesn't need to know about the plugin
type.

The deepseek pattern is `apply(ctx, config) → void |
Disposable`. We port the shape but NOT the runtime
(Cordis is intentionally not a dep). envoy-harness has
its own `Context` type that points at the `Agent` + its
sub-registries.

## Design choices (locked at chunk start)

### 1. `apply(ctx, config) → void | Disposable` is the contract

A plugin is a TypeScript module with a default export
matching `CapabilityModule`:

```ts
export interface CapabilityModule<Config = unknown> {
  /** Stable identifier (used for diagnostics + the registry). */
  readonly name: string;
  /** The main entry. Registers hooks / tools / fragments on
   *  `ctx`. Returns a `Disposable` (or `void`) that the registry
   *  calls when the plugin is unregistered. */
  apply(ctx: CapabilityContext, config: Config): Disposable | void;
}
```

**Why the default export:** `await import(modulePath)` returns
the module's namespace; the default export is the
`CapabilityModule`. No class, no factory function — just a
data + behavior object.

**Why `Disposable | void`:** the plugin can register
hooks on the agent's `HookRegistry` (and they live for
the agent's lifetime, so no disposer needed) OR it can
register per-instance state (a timer, a socket, a
sub-process) that the registry must clean up. The
`Disposable` covers the second case.

**Why a `name` field, not the module path:** the registry
indexes plugins by `name`. The module path is the LOADER's
concern (it knows where it loaded the plugin from), not
the registry's. This also lets a single plugin be re-loaded
under a different name (e.g. for testing).

### 2. `CapabilityContext` exposes the sub-registries, not the full Agent

The `Context` is the plugin's window into the harness.
v0 exposes:

- `ctx.cwd: string` — the working directory.
- `ctx.hooks: HookRegistry` — the agent's hook registry
  (read access to fire events; write access via `on` /
  `use` / `unregister`).
- `ctx.tools: ToolRegistry` — the agent's tool registry
  (read access; write access via `register` /
  `unregister`).
- `ctx.logger: PluginLogger` — a thin logger (info /
  warn / error methods that prefix the plugin's name).

The `Agent` itself is NOT exposed (plugins can't run
model calls, can't set the system prompt, can't touch
the session). This is a security boundary: a plugin can
only extend, not override.

**Why not the full Agent:** the same reason Cordis
sanitizes the `Context` — too much surface, too easy to
misuse. A plugin that needs the full Agent can be
elevated to a host (a Tauri app, a CLI wrapper) instead.

### 3. The `Config` type is `unknown` in v0 (chunk 3.1)

The deepseek pattern uses a Schemastery-validated
`Config` schema. envoy-harness uses zod, but adding
per-plugin schemas is a chunk of work. v0 accepts
`unknown` and trusts the plugin to validate internally
(if it wants to). Chunk 3.4 adds the schema path.

**Why not a `Config: z.ZodSchema<Config>` in the contract
now:** it would force every plugin to define a schema
even for trivial ones. The `unknown` default keeps the
contract minimal; chunk 3.4 is the safe-by-default path
that the curated-whitelist uses.

### 4. The loader uses dynamic `import()` + a fixed whitelist

`loadPlugin(modulePath: string)` does:
1. Look up the module's package name in a fixed
   whitelist. If not in the whitelist, throw
   `PluginLoadError` (security boundary — the host
   controls what's loadable).
2. `await import(modulePath)` to get the module's
   default export.
3. Validate the default export against `CapabilityModule`
   (has `name: string` + `apply: function`).
4. Return the module + a `Disposable` (the result of
   `apply`, or a no-op).

**Why dynamic import, not a static require:** the
plugin's path is host-supplied (from `--plugin <name>`
on the CLI, or from `cordis.yml` in a future chunk).
Static imports are resolved at compile time and don't
support user-supplied paths.

**Why a whitelist in chunk 3.1, not a free-for-all:**
a missing whitelist means anyone can ship a malicious
plugin. The whitelist is the security boundary that
keeps the seam safe. v0 ships a 1-entry whitelist
(`["envoy-harness-plugin-audit-log"]` — the built-in
sample); chunk 3.3 grows it as more samples land.

### 5. The `PluginRegistry` lives next to the `Agent`

`Agent.plugins: PluginRegistry | undefined` — when set,
the constructor calls `registry.applyAll(ctx)` on the
new agent's context. The registry tracks every
`Disposable` for `disposeAll()` (called on agent
shutdown).

**Why a registry, not just a list of loaded modules:**
the registry owns the lifecycle (apply + dispose). The
loader is the one-shot factory; the registry is the
long-lived store. A plugin can be registered, disposed,
and re-registered without re-importing.

## Files

### New

- `src/plugins/types.ts` — `CapabilityModule` +
  `CapabilityContext` + `PluginLogger` + `Disposable`. ~80 LoC.
- `src/plugins/loader.ts` — `loadPlugin(modulePath, ctx) →
  { module, dispose }`. ~80 LoC.
- `src/plugins/registry.ts` — `PluginRegistry` class.
  `register(module, config)`, `dispose(name)`, `applyAll(ctx)`,
  `disposeAll()`. ~120 LoC.
- `src/plugins/whitelist.ts` — the fixed whitelist (v0: 1
  entry). ~20 LoC.
- `src/plugins/index.ts` — public surface. Re-exports
  the types + the registry. ~10 LoC.
- `src/plugins/builtin/audit-log.ts` — the built-in
  sample plugin. Registers a `PostToolUse` hook that
  logs every tool call to a stream. ~60 LoC.
- `test/plugins/loader.test.ts` — hermetic. ~80 LoC, 4 tests.
- `test/plugins/registry.test.ts` — hermetic. ~120 LoC,
  6 tests.
- `test/plugins/builtin/audit-log.test.ts` — hermetic. ~60 LoC,
  3 tests.

### Modified

- `src/agent.ts` — add `plugins?: PluginRegistry` to
  `AgentOptions` + the `plugins` field on the class.
  When set, the constructor calls `plugins.applyAll(this)`,
  building a `CapabilityContext` from the agent's
  sub-registries. ~20 lines.
- `src/cli/argv.ts` — add `--plugin <module>` flag
  (repeatable — multiple plugins can load). +10 lines.
- `src/cli/run/one-shot.ts` — when `--plugin` is set,
  build a `PluginRegistry`, load each plugin via
  `loadPlugin(modulePath, ctx)`, then pass the registry
  to the `Agent`. ~25 lines.
- `src/index.ts` — re-export the new plugin surface. ~10 lines.

### Untouched

- The hook / tool / fragment registries (the plugin
  reads / writes them; the plugin system itself is
  orthogonal).
- The `Agent` constructor signature (additive — the
  `plugins` field is optional).
- The Cordis surface (we never import Cordis; the port
  is a structural mirror, not a runtime share).

## Test plan (hermetic)

### `loader.test.ts` (~4 tests)

- A module that exports a valid `CapabilityModule` → loaded
  + `dispose` returned (if the apply returned one).
- A module with no default export → `PluginLoadError`.
- A module with a default export that's missing `name` or
  `apply` → `PluginLoadError`.
- A module path NOT in the whitelist → `PluginLoadError`
  (security boundary; the user can't load arbitrary
  modules without explicit opt-in).

### `registry.test.ts` (~6 tests)

- `register(module, config)` calls `apply(ctx, config)`
  with the supplied context.
- `register` returns the `Disposable` from `apply` (or a
  no-op disposer when `apply` returns `void`).
- `dispose(name)` calls the registered `Disposable`.
- `applyAll(ctx)` calls every registered module's `apply`
  with the supplied context (used by the `Agent`
  constructor).
- `disposeAll()` calls every registered `Disposable` in
  reverse-registration order.
- A duplicate `name` in the registry throws.

### `audit-log.test.ts` (~3 tests)

- A `PostToolUse` hook is registered on the agent's
  `HookRegistry` (the audit-log plugin does this in
  `apply`).
- The hook fires when a tool completes; the log line
  includes the tool name + the result summary.
- `dispose()` unregisters the hook (no more log lines
  after dispose).

## Module-size check

- `plugins/types.ts` ~80 LoC (well under target).
- `plugins/loader.ts` ~80 LoC (under target).
- `plugins/registry.ts` ~120 LoC (under target).
- `plugins/whitelist.ts` ~20 LoC (small).
- `plugins/builtin/audit-log.ts` ~60 LoC (small).
- `agent.ts` grows by ~20 LoC (currently 1138; → 1158,
  same warning range — already in the over-target list).
- `cli/argv.ts` grows by ~10 LoC.
- `cli/run/one-shot.ts` grows by ~25 LoC.

No new allowlist entries needed.

## Success criteria

- A user can write a TypeScript module that exports a
  `CapabilityModule` and load it via
  `envoy --plugin my-plugin "do X"`.
- The plugin can register a hook on the agent's
  `HookRegistry`; the hook fires on the right event.
- The plugin can register a tool on the agent's
  `ToolRegistry`; the model sees the tool.
- The plugin's `dispose()` runs when the agent is
  destroyed (or when the registry's `disposeAll` is
  called).
- An unwhitelisted plugin name is rejected with
  `PluginLoadError` (security boundary; the user gets
  a clear error message).
- All existing 1285 tests still pass.
- New tests: ~13.
- Module-size check: no new file exits the allowlist.
- `AgentOptions.plugins` is optional (additive; existing
  callers don't need to change).

## Out of scope (future chunks)

- **Chunk 3.2** — More sample plugins: a hook plugin
  (the one that fires on `PreToolUse` to ask for
  confirmation), a tool plugin (a calculator), a
  bounded-fragment plugin (one that injects context).
  Each one exercises a different facet of
  `CapabilityContext`.
- **Chunk 3.3** — The curated whitelist grows as more
  built-in samples land. A user can add their own
  plugin by including it in the whitelist (the
  security boundary is the user's choice; the host
  controls the whitelist).
- **Chunk 3.4** — A `Config: z.ZodSchema<Config>` path
  for per-plugin validation. v0 accepts `unknown`; this
  chunk adds the typed path.
- **The Cordis-compat container** (Phase G). A
  L4-reuse strategy that hosts Cordis plugins inside
  envoy-harness. This lands after the seam is
  battle-tested.
- **A `cordis.yml`-driven plugin loader.** The
  `cordis.yml` already lists plugins; the
  `PluginRegistry` could read a `cordis.yml` and load
  every entry whose name is in the whitelist. This is
  the integration with chunk 15.2 (deepseek config
  import).
