# Implementation plan — Phase B / Item 15.1 (codex config.toml importer)

> **Source:** [`gap-closure-plan.md`](./gap-closure-plan.md) (item 15) +
> [`implementation-plan.md`](./implementation-plan.md) ("Phase B — Runtime
> extensibility").
>
> **Reference:** `codex/codex-rs/config/src/config_toml.rs` (the
> `TomlConfig` shape we translate from) +
> `codex-rs/config/src/hook_config.rs` (the hooks section, deferred
> to chunk 15.2).
>
> **Scope:** this chunk ships ONLY the codex config importer
> (TOML → envoy's `ConfigLayer`). The deepseek cordis.yml
> importer + the hook-protocol JSON-RPC bridge land in
> chunk 15.2. The two are separated because the codex
> importer is the most-requested format (the user explicitly
> said "codex-style importers + deepseek-style hook bridges"
> — splitting keeps each chunk small + shippable).
>
> **Status:** plan locked at 2026-08-21; awaiting sign-off.

## Why this chunk

Hosts already on codex (or migrating to envoy-harness) want
to drop their existing `~/.codex/config.toml` into
`~/.config/envoy-harness/` and have the relevant fields
"just work". Today they have to hand-port every field.
The importer:

1. **Reads** a codex-style `config.toml` (the codex schema
   is much wider than envoy's v0 `ConfigLayer`; we map the
   subset we can honor and warn on the rest).
2. **Returns** a valid `ConfigLayer` (the same shape
   `loadConfigFile` already produces) so the rest of the
   code doesn't know the difference.
3. **Reports** what was mapped + what was ignored (so the
   user can see the diff in `--verbose`).

This unblocks the migration path. Chunk 15.2 adds hooks
and deepseek on top.

## Design choices (locked at chunk start)

### 1. Field mapping is explicit, not generic

A naive `kebabToCamel` recursive converter would silently
mangle codex-specific keys (e.g. `mcp_servers` → `mcpServers`,
which envoy-harness doesn't have). Instead, we maintain a
**hand-written map** for the well-known fields. Anything not
in the map is reported as "ignored" (with the field name +
reason). This matches the existing `mapKebabToCamel` pattern
in `src/config/loader.ts` and surfaces typos / unknowns
clearly.

### 2. Importer returns the SAME `ConfigLayer` shape

`importCodexConfig(path)` returns `ConfigLayer` — the same
type the existing loader returns. The runner doesn't
distinguish "imported from codex" vs "wrote a native config"
once it has the layer. This is the L3 reuse principle
("adopt the contract, not the format").

### 3. Importer reads the file as TOML, not via `loadConfigFile`

`loadConfigFile` validates the parsed object against
`ConfigLayerSchema` (strict — unknown keys are errors).
Codex's TOML has dozens of keys envoy-harness doesn't
know about. The importer needs to parse the TOML itself
(via `smol-toml`, which the existing loader already
depends on) and then map the relevant fields into a
new object that satisfies `ConfigLayerSchema`. The existing
loader is left untouched.

### 4. CLI flag: `--import-config <path> --from <format>`

```
envoy --import-config ~/.codex/config.toml --from codex "do the thing"
```

- `--import-config <path>` — the file to import.
- `--from <format>` — explicit format selector (v0:
  only `codex` is supported). Required for now; future
  chunks add auto-detection by file content.
- The flag is parsed by `argv.ts` (additive) and threaded
  into `RunOptions`. The runner calls the importer,
  merges the result with the native config (imported
  fields win, but native CLI flags win over both), and
  passes the resolved `ConfigLayer` to the agent.

### 5. No new `ConfigLayer` fields in this chunk

Codex has `mcp_servers`, `model_providers`, `web_search`,
`skills`, `agents`, etc. — none of these have an
envoy-harness `ConfigLayer` field today. Chunk 15.1
**ignores** them (with warnings). They land in future
chunks when the corresponding envoy-harness capability
ships (MCP = T3.3, web = Phase C, etc.).

The one field we DO add to the schema is `hooks: HookSpec[]`
— but actually, on second thought, no, we DON'T add it
in chunk 15.1. Code migration is the priority; hooks
ship in chunk 15.2 with the proper `[hooks]` table
support. **This chunk imports ONLY the
permission + sandbox subset of codex's TOML.**

## Codex field → envoy-harness field map

| Codex TOML key | Codex type | Envoy-harness `ConfigLayer` key | Notes |
|---|---|---|---|
| `sandbox_mode` | `"read-only" \| "workspace-write" \| "danger-full-access"` | `permissionMode` | Direct map. Codex's `danger-full-access` is envoy's `danger-full-access`. |
| `approval_policy` | `"untrusted" \| "on-failure" \| "on-request" \| "never"` | `askForApproval` | Map `untrusted` → `unless-trusted`, `on-failure` → `granular` (closest semantics; the user is told in the warning). |
| `sandbox_workspace_write.writable_roots` | `string[]` | `writableRoots` | Direct. |
| `sandbox_workspace_write.network_access` | `bool` | `networkAccess` | Direct. |
| `sandbox_workspace_write.exclude_slash_tmp` | `bool` | `slashTmpWritable = !value` | Inverse — codex calls it "exclude", envoy calls it "writable". |

**Ignored (with warnings, in v0):** `mcp_servers`, `model`,
`model_providers`, `web_search`, `skills`, `agents`,
`profiles`, `notify`, `history`, `tui`, `hide_agent_reasoning`,
`personality`, `otel`, `analytics`, `feedback`, `apps`,
`marketplace`, `plugin`, `windows`, `sandbox`, `mcp_oauth_credentials_store`,
`memories`, `project_doc_fallback_filenames`, `project_doc_max_bytes`,
`forced_chatgpt_workspace_id`, `forced_login_method`, `cli_auth_credentials_store`.

**Always ignored (no envoy-harness equivalent at all):**
`voice` (TUI feature), `feedback` (Phase D), `apps`
(Tauri/marketplace concern), `windows` (Windows-only).

The warning is non-fatal. `--verbose` prints the ignored
list to stderr; without it, the user just gets a one-line
summary "imported N fields, ignored M (use --verbose to
list)".

## Files

### New

- `src/config/import/codex.ts` — `importCodexConfig(path,
  { warn? })` → `Promise<ConfigLayer>`. ~120 LoC.
- `src/config/import/index.ts` — public surface (re-exports
  `importCodexConfig` + a `detectCodexConfig` helper
  for the future auto-detect path). ~20 LoC.
- `test/config/import-codex.test.ts` — hermetic tests
  (parse real-world codex config samples, assert mapping).
  ~200 LoC, ~10 tests.

### Modified

- `src/config/loader.ts` — add `loadConfigWithImport({
  filePath, importPath, importFrom })` convenience that
  loads the native config + the imported config and merges
  them (imported wins on conflict; CLI flags win over
  both — handled by the runner, not here). ~30 lines.
- `src/cli/argv.ts` — add `--import-config <path>` and
  `--from <format>` flags (additive). ~15 lines.
- `src/cli/run.ts` (or wherever the runner builds the
  agent) — call `loadConfigWithImport` when
  `opts.importConfig` is set, then merge with the existing
  config flow. ~20 lines.
- `src/index.ts` — re-export `importCodexConfig`.
- `test/config.test.ts` — extend with merge tests
  (imported wins over native; native wins over default).
  ~3 tests.
- `test/cli/argv.test.ts` (if exists) — extend with
  `--import-config` parsing. ~2 tests.

### Untouched

- `ConfigLayerSchema` itself (no new fields this chunk).
- The existing `loadConfigFile` / `loadConfig` (additive
  companion function).
- Hooks (chunk 15.2).
- Deepseek (chunk 15.2).

## Test plan (hermetic)

### `import-codex.test.ts` (~10 tests, 4 describe blocks)

**Happy paths:**
- A real-world codex config sample (sanitized, from
  `codex-rs/.cargo/config.toml` + the public docs example)
  → mapped correctly.
- A minimal config (just `sandbox_mode` + `approval_policy`)
  → 2-field `ConfigLayer`.
- The `exclude_slash_tmp` field → `slashTmpWritable: true`
  (inverse).

**Edge cases:**
- Empty codex file → `{}` (no warning).
- Code-only field in codex that envoy has no equivalent
  (`mcp_servers`) → field is in the warning list, NOT in
  the returned `ConfigLayer`.
- Unknown codex field (e.g. `typo = "x"`) → warning, not
  a throw (the codex user might have a custom field).
- Codex field with the wrong type (`sandbox_mode = 123`)
  → `ConfigLoadError` (we don't silently coerce; the
  error message names the field + expected type).
- `--from codex` on a file that's not TOML → error.
- Missing file → `ConfigLoadError` (NOT silent — codex
  users explicitly asked to import this file).

**Merge tests (in `config.test.ts`):**
- Native + imported: imported wins on conflict.
- Imported + CLI flag: CLI flag wins (the runner
  enforces this; the loader just provides the merge
  primitive).

**CLI parsing tests:**
- `--import-config <path> --from codex` parses correctly.
- `--import-config <path>` without `--from` → error
  (required for v0; auto-detect is future).

## Module-size check

- `import/codex.ts` ~120 LoC (well under target).
- `config/loader.ts` grows from 217 → ~250 LoC (under
  target).
- `cli/argv.ts` grows from ~600 → ~615 LoC (over target
  but under hard cap; already in the warning list).

No new allowlist entries needed.

## Success criteria

- A user with `~/.codex/config.toml` can run
  `envoy --import-config ~/.codex/config.toml --from codex
  "do X"` and the agent honors the relevant subset
  (sandbox, approval, writable roots, network, /tmp).
- The importer reports what was ignored (with `--verbose`).
- Invalid input throws `ConfigLoadError` (not silent
  coercion).
- All existing 1218 tests still pass.
- New tests: ~15.
- Module-size check: no new file exits the allowlist.
- `BUILTIN_COMMANDS` count stays the same (no new
  slash command; the import flag is CLI-only).

## Out of scope (chunk 15.2 + future)

- Codex `[hooks]` table → envoy `HookSpec[]` (chunk 15.2).
- Deepseek `cordis.yml` YAML importer (chunk 15.2).
- JSON-RPC over stdio hook runner (chunk 15.2).
- Auto-detection of file format (chunk 15.3+ — the
  user can wait).
- Mapping codex fields that envoy-harness doesn't
  have equivalents for (`mcp_servers`, `web_search`,
  etc.) — those land when the corresponding envoy
  capabilities ship.
