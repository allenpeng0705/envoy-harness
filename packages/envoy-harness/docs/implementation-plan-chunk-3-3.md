# Implementation plan — Phase B / Item 3.3 (per-plugin config via CLI)

> **Source:** [`gap-closure-plan.md`](./gap-closure-plan.md) (item 3) +
> [`implementation-plan-chunk-3-2.md`](./implementation-plan-chunk-3-2.md)
> (the sample plugins that need configurable behavior).
>
> **Reference:** deepseek's `Plugin.config` shape (port
> the data, NOT the loader).
>
> **Scope:** wire per-plugin configs from the CLI into
> the `PluginRegistry.register(module, config, ctx)`
> call. v0 currently passes `{}` for every plugin
> (chunk 3.1, `one-shot.ts:329`). This chunk adds a
> repeatable `--plugin-config <name>:<key>=<value>`
> flag; the runner parses it into a
> `Map<pluginName, Record<string, unknown>>` and
> passes the right config to each plugin.
>
> **Out of scope (chunks 3.4, etc.):**
> - **3.4** — `Config: z.ZodSchema<Config>` for
>   runtime-validated per-plugin configs. Chunk 3.3
>   accepts `Record<string, unknown>` from the CLI
>   and passes it through; chunk 3.4 adds the
>   validation layer (zod schema on the module,
>   runner validates before `register`).
> - A "fragment" plugin (still deferred — needs
>   `ctx.fragments`).
> - Reading plugin config from a file (a future
>   `--plugin-config-file <path>` for big configs;
>   v0 CLI is sufficient).
> - Per-plugin env-var loading (a future
>   `--plugin-config-env <NAME>` to load a single
>   env var into the config; v0 is CLI-only).
>
> **Status:** plan locked at 2026-08-21; awaiting sign-off.

## Why this chunk

The chunk 3.2 sample plugins (`confirm-tool` +
`calculator`) both want user-configurable behavior:

- `confirm-tool`: which tool to filter on (default
  `bash`, override to `read_file` or whatever).
- `calculator`: how many decimal places to round to
  (default 6, override to 2 for currency, etc.).

v0 (chunk 3.1) hard-codes `{}` as the config for
every plugin (`one-shot.ts:329`). The plugins DO
read their config (`config?.tool ?? "bash"`) but
the runner never supplies a real config — the
defaults always win. Chunk 3.3 wires the path from
the CLI to the plugin.

This is also the "third dimension" of the seam:

- Chunk 3.1 — the structural types + registry
  (loaded + applied + disposed).
- Chunk 3.2 — the sample plugins (proves the
  contract is expressive enough for real plugins).
- Chunk 3.3 — the config path (proves the runner
  can pass user intent into the plugin).

Without 3.3, the chunk 3.2 plugins are
demonstrations, not configurable tools.

## Design choices (locked at chunk start)

### 1. Flag format: `--plugin-config <name>.<key>=<value>`

The CLI flag is `--plugin-config <name>.<key>=<value>`
(dot separates plugin name from key, equals
separates key from value). Repeatable: a plugin
can receive multiple `key=value` pairs by
repeating the flag.

**Example:**
```sh
envoy-harness \
  --plugin envoy-harness-plugin-confirm-tool \
  --plugin-config envoy-harness-plugin-confirm-tool.tool=read_file \
  --plugin envoy-harness-plugin-calculator \
  --plugin-config envoy-harness-plugin-calculator.precision=2 \
  "do X"
```

**Why this format:**

- **Scoped per plugin:** the `name.` prefix makes
  the config clearly belong to a specific plugin.
  A user with two plugins doesn't have to
  disambiguate "which plugin's `precision` is
  this?".
- **Repeatable:** multiple `--plugin-config` flags
  for the same plugin accumulate. The runner
  builds a `Map<pluginName, Record<string, unknown>>`
  by merging every entry for the same name.
- **No positional coupling:** unlike
  `--plugin-config-for <name>` + `--plugin-config
  <key>=<value>`, the scoped format has no
  positional coupling between flags (a user can
  group the configs together or interleave them
  with `--plugin` flags).
- **Matches the deepseek pattern:** deepseek uses
  `<plugin>.<field>=<value>` (dot-separated);
  envoy-harness adopts the same shape. v0's
  config is flat (no nested keys), so the dot
  is unambiguously the plugin-name / key
  separator. (Plugin names in the whitelist
  don't contain dots: `envoy-harness-plugin-*`
  uses only letters + hyphens.)

**Rejected alternatives:**

- `--plugin-config key=value` (unscoped): ambiguous
  when multiple plugins share keys.
- `--plugin-config <name>=<json-blob>`: harder to
  type, no incremental config.
- `--plugin-config-for <name>` + `--plugin-config
  <key>=<value>`: requires positional coupling
  (the `--plugin-config-for` must come before
  the `--plugin-config` it scopes).
- `--plugin-config <name>:<key>=<value>` (colon
  separator): rejected because the deepseek
  pattern is the prior art we want to mirror;
  the colon form is unidiomatic in TS / JS
  tooling.

### 2. Value parsing: JSON-first, fall back to string

Each `<value>` is parsed as follows:

1. Try `JSON.parse(value)`.
2. If the parse succeeds, use the parsed value
   (number, boolean, null, object, array, string).
3. If the parse throws, treat the raw string as
   the value (no quotes needed for plain strings).

**Why JSON-first:** `JSON.parse("2")` returns `2`
(number). `JSON.parse("true")` returns `true`
(boolean). `JSON.parse('"foo"')` returns `"foo"`
(string, but requires quotes). For unquoted
strings, JSON.parse throws — the fallback treats
the raw `foo` as the string `"foo"`.

**Example mappings:**

| Flag value | Parsed config value |
|---|---|
| `precision=2` | `2` (number) |
| `enabled=true` | `true` (boolean) |
| `name=hello` | `"hello"` (string) |
| `items=[1,2,3]` | `[1, 2, 3]` (array) |
| `meta={"k":1}` | `{ k: 1 }` (object) |
| `greeting="hi there"` | `"hi there"` (string with space) |
| `bad={not valid` | `"bad={not valid"` (string fallback) |

**Why not coerce-by-literal:** deepseek uses
literal-type detection (`if (s === "true")`); v0
chose JSON-first because:
- One parser (the stdlib's `JSON.parse`).
- No ambiguity (`true` parses to boolean; only
  the literal `"true"` in JSON-quotes parses to
  the string `"true"`).
- Users can pass numbers / booleans without
  quoting; they only need to quote strings with
  spaces or special characters.

**Edge cases:**

- Empty value (`name=`): the value is the empty
  string `""`.
- No `=` in the flag (just `--plugin-config foo`):
  throw `ArgvError` (the user forgot the `key=value`).
- No `:` in the flag (just `--plugin-config foo=bar`):
  throw `ArgvError` (the user forgot the `<name>:`).

### 3. The runner's contract: `Map<name, config>`

The runner (chunk 3.1's `one-shot.ts`) reads every
`--plugin-config` flag, builds a
`Map<pluginName, Record<string, unknown>>`, and
passes the right config to each plugin's
`register(module, config, ctx)` call.

**Pseudocode:**

```ts
const pluginConfigs = new Map<string, Record<string, unknown>>();
// (parse every --plugin-config flag)

for (const modulePath of parsed.plugins) {
  // ... whitelist check, load ...
  const config = pluginConfigs.get(modulePath) ?? {};
  registry.register(loaded.module, config, pluginCtx);
}
```

**Why the plugin name is the key:** the plugin's
`name` field is the registry's key. The CLI flag's
`<name>.` prefix is the SAME name. The user types
the plugin name twice (in `--plugin` and in
`--plugin-config`); this is intentional — it
makes the scoped config obvious.

**Why pass `{}` (not `undefined`):** the
`register` API takes `config: Config` (not
`Config | undefined`); passing `{}` is the
"no config supplied" default. The plugin's
`config?.prefix ?? "audit"` pattern still works
(empty object's `prefix` is `undefined`).

### 4. The new CLI flag is a "valued" repeatable

The flag joins `RUN_FLAGS` (so unknown-flag
detection fires), `RUN_VALUED_FLAGS` (so the
value-consuming logic fires), and the
per-flag handler pushes a parsed
`PluginConfigEntry` (a new type) onto
`out.pluginConfigs: PluginConfigEntry[]`.

**The parsed shape:**

```ts
interface PluginConfigEntry {
  /** The plugin name (must match a `--plugin` entry). */
  name: string;
  /** The config key. */
  key: string;
  /** The parsed config value. */
  value: unknown;
}
```

**Why a flat list, not a `Map` in `ParsedArgs`:**
the parser is pure (no side effects); building a
`Map` from the flat list happens in the runner.
This keeps the parser testable (the same pattern
as `--plugin` → `plugins: string[]`).

### 5. The parser is a small standalone module

`src/plugins/config-parser.ts` exports:

```ts
/** Parse a single `--plugin-config <spec>` value. */
export function parsePluginConfigEntry(
  spec: string,
): PluginConfigEntry;

/** Build a `Map<name, config>` from a flat list of entries. */
export function mergePluginConfigs(
  entries: ReadonlyArray<PluginConfigEntry>,
): Map<string, Record<string, unknown>>;
```

**Why a module, not inline in `argv.ts`:** the
parser is the same logic the deepseek reference
uses; it deserves its own file for clarity +
testing. `argv.ts` only calls
`parsePluginConfigEntry` per flag value.

**Why a module, not inline in `one-shot.ts`:**
`mergePluginConfigs` is a pure function; the
runner calls it after the parser. Keeping it in
`one-shot.ts` would force the runner to know
about the entry shape.

## Files

### New

- `src/plugins/config-parser.ts` — the standalone
  parser. `parsePluginConfigEntry(spec)` +
  `mergePluginConfigs(entries)`. ~60 LoC.
- `test/plugins/config-parser.test.ts` — unit
  tests for the parser. ~120 LoC, ~7 tests.

### Modified

- `src/cli/argv.ts` — add `--plugin-config` to
  `RUN_FLAGS` + `RUN_VALUED_FLAGS`; per-flag
  handler in `parseRunArgs`; new
  `pluginConfigs: PluginConfigEntry[]` field on
  `RunParsedArgs`; help text. ~25 lines.
- `src/cli/run/one-shot.ts` — call
  `mergePluginConfigs(parsed.pluginConfigs)`,
  pass per-plugin config to
  `registry.register(module, config, pluginCtx)`.
  ~15 lines.
- `src/index.ts` — re-export `PluginConfigEntry`,
  `parsePluginConfigEntry`, `mergePluginConfigs`.
  ~3 lines.
- `src/plugins/index.ts` — re-export the new
  parser symbols. ~2 lines.

### Untouched

- The plugin seam (`types.ts`, `loader.ts`,
  `registry.ts`) — `register`'s `config: Config`
  param already accepts any shape; chunk 3.3 just
  supplies a real one.
- The built-in sample plugins (chunk 3.2) — their
  config-reading pattern (`config?.tool ?? "bash"`)
  already supports real configs; no code change.
- The `agent.ts` — the host (runner) owns the
  per-plugin config wiring.

## Test plan (hermetic)

### `config-parser.test.ts` (~7 tests)

1. `parsePluginConfigEntry("foo:bar=1")` →
   `{ name: "foo", key: "bar", value: 1 }`
   (number).
2. `parsePluginConfigEntry("foo:bar=true")` →
   `{ name: "foo", key: "bar", value: true }`
   (boolean).
3. `parsePluginConfigEntry("foo:bar=hello")` →
   `{ name: "foo", key: "bar", value: "hello" }`
   (string fallback when JSON.parse throws).
4. `parsePluginConfigEntry('foo:bar="hi there"')` →
   `{ name: "foo", key: "bar", value: "hi there" }`
   (quoted string).
5. `parsePluginConfigEntry("foo:bar=[1,2,3]")` →
   `{ name: "foo", key: "bar", value: [1, 2, 3] }`
   (array).
6. `parsePluginConfigEntry("no-colon")` throws
   `ArgvError` (no `.`).
7. `parsePluginConfigEntry("foo.no-equals")` throws
   `ArgvError` (no `=`).
8. `mergePluginConfigs` collapses multiple entries
   for the same plugin into a single object.

### `cli.test.ts` (~3 new tests)

9. `--plugin-config name.key=value` parses to a
   `PluginConfigEntry` with the right name, key,
   and value.
10. Multiple `--plugin-config` flags accumulate
    into a flat `pluginConfigs` list.
11. `--plugin-config` with no value throws
    `ArgvError` (matches the "valued flag" pattern).

## Module-size check

- `config-parser.ts` ~60 LoC (under target).
- `config-parser.test.ts` ~120 LoC (under target).
- `argv.ts` grows by ~25 LoC (currently 716;
  → 741, still in the over-target list — already
  in the allowlist for that reason).
- `one-shot.ts` grows by ~15 LoC (currently 361;
  → 376, still under target).

No new allowlist entries.

## Success criteria

- A user can run
  `envoy-harness --plugin envoy-harness-plugin-calculator --plugin-config envoy-harness-plugin-calculator.precision=2 "do X"`
  and the calculator tool's config has
  `precision: 2` (not the default 6).
- A user can pass multiple `--plugin-config` flags
  for the same plugin and the configs accumulate.
- `--plugin-config foo.bar=1` (number) and
  `--plugin-config foo:bar=true` (boolean) and
  `--plugin-config foo:bar=hello` (string) all
  parse to the right JS values.
- A malformed `--plugin-config` (no `:`, no `=`)
  throws `ArgvError` with a clear message.
- All existing 1318 tests still pass.
- New tests: ~11.
- Module-size check: no new file exits the
  allowlist.

## Out of scope (future chunks)

- **Chunk 3.4** — `Config: z.ZodSchema<Config>`:
  the `register` API gains an optional
  `validateConfig` step that runs the config
  through the plugin's zod schema before calling
  `apply`. Invalid configs throw
  `PluginConfigError`.
- **`--plugin-config-file <path>`** — a future
  chunk can read a JSON file of per-plugin
  configs (useful for big configs). v0 CLI is
  sufficient for the chunk 3.2 + 3.3 use case.
- **`--plugin-config-env <NAME>`** — a future
  chunk can load a single env var into the
  config. v0 doesn't read env vars for plugin
  config.
- **`PluginConfigEntry` validation** — the parser
  doesn't validate the plugin name (the
  whitelist check is in the runner). A future
  chunk can add a parser-side check ("plugin
  name not in whitelist" throws before the
  import).
- **JSON Schema for the `Config` type** — chunk
  3.4 adds the zod schema; a future chunk can
  derive a JSON Schema for IDE tooltips + the
  system prompt's plugin list.
