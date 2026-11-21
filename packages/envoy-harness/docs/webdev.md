# Web app agent capabilities

Envoy-harness can drive **Vite / React / Next / SPA** UI-debug loops with a
local Chromium (Playwright), optional remote browser workers over the mesh,
and the existing jobs/PTY path for long-lived `dev` servers.

## Permission preset

```bash
envoy-harness --permission-preset webdev --repl
# or in config.toml:
# permission_preset = "webdev"
# or REPL: /preset webdev
```

The `webdev` preset sets:

- `permissionMode = workspace-write`
- `askForApproval = on-request`
- `autoRun = safe-only`
- `networkAccess = true`
- extra `writableRoots`: `node_modules/.vite`, `.next`, `dist`, `.nuxt`,
  `.output`, Playwright browser cache (`~/.cache/ms-playwright` / macOS
  Library Caches), etc.

`browser_*` tools are gated: they require this preset’s high-signal roots
(`.vite` / `.next` / `.nuxt` / `.output` / `.svelte-kit` / `ms-playwright` /
`playwright-report` — not a bare `dist/`), `danger-full-access` /
approve-all, or `ENVOY_WEB_TOOLS=1`.

## Browser tools

Requires optional `playwright` + Chromium:

```bash
npm i playwright && npx playwright install chromium
```

| Tool | Role |
|---|---|
| `browser_navigate` | Open/goto URL; wait for load |
| `browser_snapshot` | Accessibility tree + actionable `ref=eN` |
| `browser_click` / `browser_type` / `browser_press` | Act by selector or snapshot ref |
| `browser_screenshot` | PNG → **vision** multimodal tool result |
| `browser_console` | Recent console messages / errors |
| `browser_network` | Recent request/response summary |
| `browser_close` | Close page/context |

Headless by default; pass `headed: true` on `browser_navigate` when a display
is available. Long `vite` / `next dev` / builds should use **jobs / PTY**.

## Skills

Bundled under `packages/envoy-harness/skills/`:

- `vite-react`
- `nextjs`
- `frontend-debug`

Loaded via the package skill root (`package:envoy`) alongside mobile skills.

## Vision bridging

Same multimodal path as mobile screenshots: Anthropic `tool_result` image
blocks / OpenAI-compatible follow-up `image_url` parts. WebUI renders tool
images in the transcript.

## Remote browser worker (mesh)

On a host with Playwright/Chromium:

```bash
envoy-peer serve --port 8123 --peer-id web-lab \
  --adapter ./path-to-envoy-harness-adapter.mjs \
  --browser-worker --advertise
```

Laptop agent:

```bash
envoy-harness --repl --peers web-lab@192.168.1.10:8123 --permission-preset webdev
```

Route long UI debug with `task` toward capability `browser-worker` / skill
`browser-debug`. Helpers live in `src/web/browser-worker.ts`.

## Smoke test

```bash
ENVOY_WEB_SMOKE=1 pnpm --filter @envoymesh/envoy-harness test test/web/smoke.test.ts
```
