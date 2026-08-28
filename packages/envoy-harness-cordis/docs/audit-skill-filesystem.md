# Audit record — `@deepseek-ai/dsh-skill-filesystem@0.1.1-rc.2`

> C1/C3 audit (2026-08-22). Required before a plugin may load in the
> Cordis-compat container (see `docs/cordis-compat-plan.md` §6).

## Consumed ctx surface (evidence from the published `lib/index.js`)

| Key | Kind | How it's used | Provided by |
|---|---|---|---|
| `ctx.effect` | Cordis fiber API | effect-scoped registration/disposal of the skill provider + watchers | `@deepseek-ai/cordis` (built-in) |
| `ctx.skills` | service | `registerProvider(...)` — the provider registers on the skill registry | `@deepseek-ai/dsh-skill` (`SkillRegistry` Service, applied by the container) |
| `ctx.fs` | service | file reads via `fs.resolve/stat/readText/listDir` when a backend is present | `@deepseek-ai/dsh-fs-local` (concrete backend, applied by the container) |
| `ctx.get` | reflect service | `optionalFileSystem(ctx)` → `ctx.get("fs")` | `@deepseek-ai/cordis` (built-in) |
| `ctx.logger` | logger service | warn-and-skip on malformed skill files | `@deepseek-ai/cordis` (built-in) |
| `ctx.on` | event bus | host mutation observations (watch mode) | `@deepseek-ai/cordis` (built-in) |

The plugin also reads `node:fs/promises` directly (`access/lstat/readFile/
readdir/stat`) when no `ctx.fs` backend is present, and uses `chokidar`
for watch mode. With the container's `ctx.fs` backend, file access goes
through the dsh fs service.

## Audit checklist result

1. ✅ Consumed ctx keys enumerated from source (table above).
2. ✅ No Cordis fiber usage beyond the documented effect API.
3. ✅ No scope-layer mutation beyond the documented registry write.
4. ✅ No `ctx.model` streaming assumptions.
5. ✅ Event bus used only for host-mutation observations (watch mode),
   not for correctness of discovery/load.
6. ✅ Config via schemastery (`export const Config: Schema<Config>`).
7. ⚠️ Uses `node:fs/promises` directly for scanning (not through `ctx.fs`).
   Acceptable for the spike (read-only scans); the C2 sandbox-gated fs
   adapter + a follow-up that forces the `ctx.fs` path close this.
8. ✅ Version pinned exact (`0.1.1-rc.2`) in `package.json`.

## Envoy adapters required

- `fs` — the abstract `dsh-fs` Service Definition needs a concrete backend;
  the container applies the published `@deepseek-ai/dsh-fs-local` (C2 note:
  replace/augment with a sandbox-gated envoy fs adapter for production).
- `skills` — the published `SkillRegistry` Service is applied as-is.
- No other adapters for this plugin.

## Parity evidence

`test/skill-filesystem.test.ts` — the hosted provider discovers + loads a
SKILL.md fixture from a custom root via `ctx.skills`, and matches envoy's
native SKILL.md loader for the same fixture (name + description). Passing.
