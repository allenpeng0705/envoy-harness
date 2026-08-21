# Implementation plan — Phase B / Item 3.4 (typed per-plugin configs)

> **Source:** [`gap-closure-plan.md`](./gap-closure-plan.md) (item 3) +
> [`implementation-plan-chunk-3-3.md`](./implementation-plan-chunk-3-3.md)
> (the CLI path this chunk builds on).
>
> **Reference:** deepseek's `Config: S<T>` Schemastery-
> validated config pattern. We port the SHAPE (zod, not
> Schemastery — already a dep) but not the runtime.
>
> **Scope:** add an optional
> `configSchema?: z.ZodSchema<Config>` field to
> `CapabilityModule`. The runner validates the per-
> plugin config (from chunk 3.3) against the schema
> BEFORE calling `apply`. Invalid configs throw
> `PluginConfigError` with the plugin name + the
> zod error message. The built-in sample plugins
> (chunk 3.1 + 3.2) gain real schemas in this chunk
> (a v0 `unknown` config is replaced with a typed
> `z.object({...})`).
>
> **Out of scope (chunks 3.5+):**
> - The Cordis-compat container (still deferred).
> - Per-plugin config from a file or env var
>   (chunk 3.3 is CLI-only; future chunks can add
>   the other sources).
> - A JSON Schema export for IDE tooltips
>   (`zod-to-json-schema` would be a small
>   dep; future chunk).
> - A `Config` field on `HookHandlerSpec` (config-
>   driven hooks; future chunk).
>
> **Status:** plan locked at 2026-08-21; awaiting sign-off.

## Why this chunk

Chunk 3.3 wires per-plugin configs from the CLI to
`apply(ctx, config)`. The plugin's `config` param is
typed `Config` (where `Config` defaults to
`unknown` in `CapabilityModule<unknown>`). Plugins
read their config like this:

```ts
const prefix = (config as { prefix?: string })?.prefix ?? "audit";
```

The cast is the "trust the plugin author" pattern
(chunk 3.1, `audit-log.ts:57`). It works for the
chunk 3.1 + 3.2 sample plugins (the cast is
trivially correct because the plugin author also
wrote the type annotation). It does NOT work for:

- A third-party plugin whose author doesn't
  publish a TS type (a JS plugin, or a TS plugin
  with a typo).
- A first-party plugin with a runtime-only check
  (e.g. "precision must be ≥ 0").
- A user-supplied config from `--plugin-config`
  that doesn't match the plugin's expected shape
  (silent failure → undefined → default → "why
  isn't my config working?").

Chunk 3.4 adds the safe-by-default path:
`configSchema?: z.ZodSchema<Config>` is an
optional field on `CapabilityModule`. The runner
validates the config against the schema before
calling `apply`. Invalid configs throw
`PluginConfigError` with a clear message.

**The first three built-in sample plugins get real
schemas in this chunk** — this is the "eat your own
dog food" moment. The plugins are written
defensively (parse the config defensively in v0);
with the schema, they can trust the config and
remove the cast.

## Design choices (locked at chunk start)

### 1. `configSchema` is an OPTIONAL field on `CapabilityModule`

```ts
export interface CapabilityModule<Config = unknown> {
  readonly name: string;
  /**
   * Optional zod schema. When set, the runner
   * validates the config against this schema
   * before calling `apply`. When unset, the
   * config is passed through as `unknown`
   * (the v0 contract; the plugin validates
   * internally if it wants to).
   */
  readonly configSchema?: z.ZodSchema<Config>;
  apply(ctx: CapabilityContext, config: Config): Disposable | void;
}
```

**Why optional:** the v0 contract is `unknown`;
forcibly adding a schema would break the
chunk 3.1 + 3.2 plugins. A new field (with
`?`) is additive — existing plugins compile
unchanged, the runner checks for the field
and validates only when present.

**Why on the default export, not a separate
named export:** the plugin module's `default`
export IS the `CapabilityModule`. Adding a
`configSchema` field keeps everything in one
place. A separate named export would require
the loader to do `mod.default.configSchema ||
mod.configSchema` — more code, no benefit.

**Why `z.ZodSchema<Config>` (not a custom type):**
zod is already a dep. The plugin can `import
{ z } from "zod"` and write the schema with
the same library the rest of the harness
uses. No new dependency, no new mental model.

### 2. The runner validates BEFORE `register`, not during `apply`

The validation step is in the runner, NOT in the
plugin's `apply`. The reason is twofold:

1. **Fail-fast:** an invalid config is a host
   error (the user passed bad CLI flags). The
   runner should throw before any plugin
   touches the agent's hooks / tools registries.
2. **Simpler contract:** `apply` always gets a
   valid `Config`. The plugin doesn't need to
   re-validate or handle `z.ZodError`; it can
   trust the config.

**The runner's flow:**

```ts
const config = pluginConfigs.get(modulePath) ?? {};
// Validate if the module declares a schema.
if (loaded.module.configSchema) {
  const result = loaded.module.configSchema.safeParse(config);
  if (!result.success) {
    throw new PluginConfigError(
      modulePath,
      result.error.issues,
    );
  }
}
registry.register(loaded.module, config, pluginCtx);
```

**Why `safeParse` (not `parse`):** the error
shape is the zod `ZodError.issues` array. We
forward that into `PluginConfigError` so the
caller can format a clear message (key, expected
type, got value).

### 3. New error class: `PluginConfigError`

```ts
export class PluginConfigError extends Error {
  override readonly name = "PluginConfigError";
  constructor(
    readonly pluginName: string,
    readonly issues: ReadonlyArray<z.core.$ZodIssue>,
  ) {
    super(
      `plugin '${pluginName}' config is invalid: ` +
        issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
    );
  }
}
```

**Why a new class, not reuse `PluginLoadError`:**
the two errors have different semantics. `PluginLoadError`
is "the module didn't load" (module-shape, whitelist,
import failure). `PluginConfigError` is "the module loaded
fine but the config is wrong" (runtime validation).
The CLI catches each differently:
- `PluginLoadError` → exit `EXIT_USAGE` with a
  "couldn't load" message.
- `PluginConfigError` → exit `EXIT_USAGE` with a
  "config is invalid" message + the zod issue list.

**Why `readonly issues: ReadonlyArray<...>`:** the
zod issues are stable; the caller can introspect
them (e.g. for IDE integrations) without copying.

### 4. The built-in sample plugins get real schemas

The chunk 3.1 + 3.2 plugins all currently do
`(config as { ... })?.x ?? default`. With the
schema, the cast is replaced by a typed config
(via `z.infer<typeof configSchema>`), and the
`?? default` is replaced by `config.x ?? default`
(trusting the schema for the shape; the default
handles the `optional` case).

**`audit-log` schema:** `z.object({ prefix: z.string().optional() })`.
Default: `{ prefix: "audit" }`.

**`confirm-tool` schema:** `z.object({ tool: z.string().optional() })`.
Default: `{ tool: "bash" }`.

**`calculator` schema:** `z.object({ precision: z.number().int().min(0).max(15).optional() })`.
Default: `{ precision: 6 }`. (The `.max(15)` caps
the precision — `toFixed(16)` is silly and could
mask bugs.)

**Why `z.infer<typeof configSchema>` IS the `Config`
type:** the `CapabilityModule<Config>` generic
narrows. The plugin is typed as
`CapabilityModule<z.infer<typeof configSchema>>`,
so `apply`'s `config` param is the inferred type
(no cast, full IDE support).

### 5. Validation is opt-in per plugin

A plugin without a `configSchema` field works
exactly as v0 (the config is `unknown`, the
plugin validates internally if it wants to). The
runner does NOT default-validate (it doesn't
have a schema to validate against).

**Why opt-in, not opt-out:** an opt-out default
would require the v0 sample plugins to define a
schema or be tagged "no validation". An opt-in
default lets the v0 plugins land before the
schema path; the chunk 3.4 upgrade is purely
additive.

**Future chunks can flip the default:** when all
the built-in samples have schemas, a future
chunk can default to "validate if schema is
present; warn if absent". v0 doesn't warn (no
schema is a feature, not a bug).

## Files

### New

- `src/plugins/validate-config.ts` — the
  validation helper. `validatePluginConfig(module,
  config) → config` (returns the validated
  config; throws `PluginConfigError` on
  failure). ~30 LoC.
- `test/plugins/validate-config.test.ts` — unit
  tests for the validation. ~80 LoC, ~4 tests.

### Modified

- `src/plugins/types.ts` — add
  `configSchema?: z.ZodSchema<Config>` to
  `CapabilityModule`. New `PluginConfigError`
  class. ~25 lines.
- `src/plugins/builtin/audit-log.ts` — add
  `configSchema` field; remove the cast;
  tighten the type. ~10 lines changed.
- `src/plugins/builtin/confirm-tool.ts` — add
  `configSchema` field; remove the cast; tighten
  the type. (New file from chunk 3.2.)
- `src/plugins/builtin/calculator.ts` — add
  `configSchema` field; remove the cast;
  tighten the type. (New file from chunk 3.2.)
- `src/cli/run/one-shot.ts` — call
  `validatePluginConfig` before
  `registry.register`. Catch `PluginConfigError`
  → `CliError(EXIT_USAGE)`. ~10 lines.
- `src/plugins/index.ts` — re-export
  `validatePluginConfig`, `PluginConfigError`. ~2
  lines.
- `src/index.ts` — re-export `PluginConfigError`. ~1
  line.

### Untouched

- The loader — it doesn't validate the config
  (no config at load time).
- The registry — it doesn't validate (the
  validation happens before `register`).
- The CLI argv parser — the parser hands over
  the raw config map; the runner validates.

## Test plan (hermetic)

### `validate-config.test.ts` (~4 tests)

1. A module WITHOUT a `configSchema` → config
   passes through unchanged (no validation, no
   error).
2. A module WITH a `configSchema` and a valid
   config → config passes through (the runner
   uses the validated value).
3. A module WITH a `configSchema` and an invalid
   config → throws `PluginConfigError` with the
   zod issue in the message.
4. The `PluginConfigError` includes the plugin
   name + the issue path + the issue message
   (so the user can see exactly which field
   was wrong).

### `audit-log.test.ts` (~1 new test, ~1 updated)

5. (Updated) The audit-log plugin's
   `configSchema` rejects a non-string
   `prefix` (e.g. `{ prefix: 42 }`).
6. (New) The audit-log plugin's
   `configSchema` accepts `{ prefix: "x" }`
   and `{ prefix: undefined }` (optional).

### `confirm-tool.test.ts` (~1 new test)

7. The confirm-tool plugin's `configSchema`
   rejects `{ tool: 42 }` (must be string).
   (New file from chunk 3.2.)

### `calculator.test.ts` (~2 new tests)

8. The calculator plugin's `configSchema`
   accepts `{ precision: 6 }`.
9. The calculator plugin's `configSchema`
   rejects `{ precision: -1 }` (below the
   minimum). (New file from chunk 3.2.)

### `cli.test.ts` (~1 new test)

10. End-to-end: `--plugin some-valid-plugin
    --plugin-config some-valid-plugin:badField=42`
    (where the plugin's schema rejects
    `badField`) → runner throws `CliError` with
    the `PluginConfigError` message.

## Module-size check

- `validate-config.ts` ~30 LoC (under target).
- `validate-config.test.ts` ~80 LoC (under target).
- `types.ts` grows by ~25 LoC (currently 145; →
  170, still under target).
- `audit-log.ts` grows by ~10 LoC.
- `confirm-tool.ts` (~80 LoC) + `calculator.ts`
  (~100 LoC) gain ~10 lines each.
- `one-shot.ts` grows by ~10 LoC (currently 361;
  → 371, still under target).

No new allowlist entries.

## Success criteria

- A plugin can declare
  `configSchema: z.object({ ... })` and the
  runner validates the CLI-supplied config
  before calling `apply`.
- An invalid config (e.g.
  `--plugin-config calculator:precision=-1`)
  throws `PluginConfigError` with a clear
  message that names the plugin + the field +
  the zod issue.
- A plugin WITHOUT a `configSchema` works
  unchanged (the v0 contract is preserved).
- The chunk 3.1 + 3.2 built-in plugins
  (`audit-log`, `confirm-tool`, `calculator`)
  all gain real schemas; the existing tests
  still pass (the schema is a superset of
  the cast-based default).
- All existing 1329 tests still pass.
- New tests: ~10.
- Module-size check: no new file exits the
  allowlist.

## Out of scope (future chunks)

- **JSON Schema export** — `zod-to-json-schema` is
  a small dep; a future chunk can derive a JSON
  Schema for IDE tooltips + the system prompt's
  plugin list.
- **Config from a file** — `--plugin-config-file
  <path>` reads a JSON file. v0 is CLI-only.
- **Config from env** — `--plugin-config-env
  <NAME>` loads a single env var. v0 doesn't read
  env vars.
- **Config inheritance** — sub-agents inheriting
  a parent's plugin configs. v0 doesn't have
  sub-agents-with-plugins.
- **The Cordis-compat container** — when it
  ships, the container's plugins will get the
  same zod validation path (the container
  re-uses the runner's `validatePluginConfig`).
- **A `Config` field on `HookHandlerSpec`** —
  config-driven hooks (chunk 15.2) get the same
  validation path. v0 hooks don't have a
  `Config` field.
