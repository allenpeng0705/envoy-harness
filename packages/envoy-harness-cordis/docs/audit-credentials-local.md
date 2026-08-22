# Audit record — `@deepseek-ai/dsh-credentials-local@0.1.1-rc.2`

> C3 audit (2026-08-22). Required before a plugin may load (see
> `docs/cordis-compat-plan.md` §6).

## Consumed ctx surface (evidence from the published `lib/index.js`)

| Key | Kind | How it's used | Provided by |
|---|---|---|---|
| `ctx.logger` | logger service | watcher/parse warnings | `@deepseek-ai/cordis` (built-in) |
| `ctx.effect` (via base) | Cordis fiber | provider lifecycle | `@deepseek-ai/cordis` (built-in) |

`LocalCredentialProvider extends CredentialProvider` (the abstract
`dsh-credentials` Service) — applying it registers `ctx.credentials`
itself. It reads the credentials document via `node:fs/promises` and
`chokidar` (watch mode).

## Audit checklist result

1. ✅ Consumed ctx keys enumerated from source.
2. ✅ No Cordis fiber usage beyond the documented effect API.
3. ✅ No scope-layer mutation.
4. ✅ No `ctx.model` streaming assumptions.
5. ✅ Event bus not used for correctness.
6. ✅ Config via schemastery (`static Config: z<Config>`).
7. ✅ File access is the plugin's own credential document (mode-600
   enforced by the plugin itself — it refuses world-readable files).
8. ✅ Version pinned exact (`0.1.1-rc.2`).

## Envoy adapters required

None for hosting — the plugin is self-contained (file-backed). Redaction is
handled at the envoy trace layer (`src/credentials/redaction.ts`) when
hosts surface resolved values.

## Parity / functional evidence

`test/c3-plugins.test.ts` — a mode-600 `.credentials.yaml` document
resolves through `ctx.credentials.resolve(credentialRef("EXA_API_KEY"))`
to the stored value. Passing.
