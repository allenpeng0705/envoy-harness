# Audit record — `@deepseek-ai/dsh-web-search-exa@0.1.1-rc.2`

> C3 audit (2026-08-22). Required before a plugin may load (see
> `docs/cordis-compat-plan.md` §6).

## Consumed ctx surface (evidence from the published `lib/index.js`)

| Key | Kind | How it's used | Provided by |
|---|---|---|---|
| `ctx.web` | service | `registerSearchProvider(...)` on the web runtime | `@deepseek-ai/dsh-web` (`WebRuntime`, applied by the container) |
| `ctx.llm` | service | provider prompt rendering (search-time only) | `@deepseek-ai/dsh-llm` (`LlmRuntime`, applied by the container) |

The plugin is a named-exports namespace (`apply`, `Config`, `name`,
`inject`); no default export. Network access happens only inside a search
call (the Exa API), gated by the configured API key.

## Audit checklist result

1. ✅ Consumed ctx keys enumerated from source.
2. ✅ No Cordis fiber usage.
3. ✅ No scope-layer mutation.
4. ✅ No `ctx.model` streaming assumptions (`ctx.llm` is used only for
   prompt rendering at search time).
5. ✅ Event bus not used.
6. ✅ Config via schemastery (`export const Config: z<Config>`).
7. ✅ Network: only the configured Exa provider endpoint, only on an
   explicit `search` call.
8. ✅ Version pinned exact (`0.1.1-rc.2`).

## Envoy adapters required

- `web` — the published `WebRuntime` Service is applied as-is.
- `llm` — the published `LlmRuntime` Service is applied as-is (search-time
  prompt rendering; no envoy adapter needed for hosting).
- No envoy adapters for the provider itself.

## Functional evidence

`test/c3-plugins.test.ts` — the plugin applies and registers its provider
on `ctx.web` (a duplicate registration would throw
`WEB_DUPLICATE_PROVIDER`); `ctx.web.search`/`fetch` are runnable. No
network call in tests.
