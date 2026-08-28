# Audit record — `@deepseek-ai/dsh-jobs-local@0.1.1-rc.2`

> C0 spike audit (2026-08-22). Every whitelisted plugin in the Cordis-compat
> container needs one of these before it may load (see
> `docs/cordis-compat-plan.md` §6).

## Consumed ctx surface (evidence from the published `lib/index.js`)

| Key | Kind | How it's used | Provided by |
|---|---|---|---|
| `ctx.effect` | Cordis fiber API | effect-scoped disposal/registration (listeners, owner cleanup) | `@deepseek-ai/cordis` (built-in) |
| `ctx.jobs` | service (provides) | the registry registers itself as `ctx.jobs` (extends Cordis `Service`) | the plugin itself |
| `ctx.get` | reflect service | `selfCtx.get` service lookup for detached settlement continuations | `@deepseek-ai/cordis` (built-in) |
| `ctx.logger` | logger service | `selfCtx.logger.warn(...)` on teardown-cancel failures | `@deepseek-ai/cordis` (built-in) |

No `ctx.scope` service, no `ctx.timeout` service, no `ctx.invariants`
runtime calls, no event-bus dependence, no `ctx.model` — the peer packages
(`dsh-scope`, `dsh-timeout`, `dsh-invariants`) are used as pure utility
libraries (`ScopedLayers`, `scopeOf`, `deadline`, `timeoutOf`), and
`dsh-agent` is type-only (`type { Agent }`).

## Audit checklist result

1. ✅ Consumed ctx keys enumerated from source (table above).
2. ✅ No Cordis fiber usage beyond the documented effect API.
3. ✅ No scope-layer mutation beyond the documented registry layers.
4. ✅ No `ctx.model` streaming assumptions.
5. ✅ No event-bus dependence for correctness (logging only).
6. ✅ Config via schemastery (`static Config: z<Config>`).
7. ✅ No raw `node:fs`/`child_process` in the plugin — producers inject their
   own `JobHooks`.
8. ✅ Version pinned exact (`0.1.1-rc.2`) in `package.json`.

## Envoy adapters required

**None for the jobs capability** — jobs-local only needs Cordis built-ins.
This is why the C0 spike chose it first: it proves the hosting architecture
(real Cordis context + published dsh packages + `ctx.plugin`) with zero
adapter surface.

## Parity evidence

`test/jobs-parity.test.ts` runs the same producer contract through the hosted
`dsh-jobs-local` and envoy's native `src/jobs` port: identical status
sequences (`running → completed → completed`), same kill semantics, same
snapshot shape. Passing.
