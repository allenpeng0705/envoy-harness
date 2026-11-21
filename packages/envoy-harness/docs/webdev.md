# Web app agent capabilities

Envoy-harness can drive **Vite / React / Next / SPA** UI-debug loops with a
local Chromium (Playwright), optional remote browser workers over the mesh,
and the existing jobs/PTY path for long-lived `dev` servers.

For Flutter / RN / native device loops, see [`mobile.md`](./mobile.md).

## Permission preset

```bash
envoy-harness --permission-preset webdev --repl
# or in config.toml:
# permission_preset = "webdev"
# or REPL: /preset webdev
# or ACP/SDK: session/set_policy { "preset": "webdev" }
```

The `webdev` preset sets:

| Axis | Value |
|---|---|
| `permissionMode` | `workspace-write` |
| `askForApproval` | `on-request` |
| `autoRun` | `safe-only` |
| `networkAccess` | `true` |
| Extra `writableRoots` | `node_modules/.vite`, `node_modules/.cache`, `.next`, `dist`, `.nuxt`, `.output`, `.svelte-kit`, `playwright-report`, `test-results`, Playwright browser cache (`$XDG_CACHE_HOME/ms-playwright` or `~/.cache/ms-playwright`, plus macOS `~/Library/Caches/ms-playwright`) |

### Gating `browser_*`

Tools run only when one of these is true:

1. Sandbox writable roots include a **high-signal** webdev marker  
   (`.vite` / `node_modules/.cache` / `.next` / `.nuxt` / `.output` /
   `.svelte-kit` / `ms-playwright` / `playwright-report`), **or**
2. `permissionMode = danger-full-access` / `approve-all`, **or**
3. `ENVOY_WEB_TOOLS=1`

A bare project `dist/` or generic `test-results/` alone does **not** unlock
the tools (same idea as mobile not treating a bare `…/build` as a Simulator
root). The preset still *adds* `dist` / `test-results` as writable paths for
builds; the gate keys off markers that identify a frontend/Playwright layout.

`mobile` and `webdev` share sandbox/approval/auto-run axes. Hosts should keep
the named preset (`Agent.getPermissionPreset` / ACP `get_policy`) rather than
inferring from axes alone.

## Browser tools

Optional dependency (peer / optionalDep):

```bash
npm i playwright && npx playwright install chromium
# or from the harness package: pnpm add playwright && pnpm exec playwright install chromium
```

Minimum supported: Playwright **≥ 1.49**. Prefer a build that still exposes
`page.accessibility.snapshot`; on newer builds the tools fall back to
`locator.ariaSnapshot()` (YAML text, fewer structured refs).

| Tool | Role |
|---|---|
| `browser_navigate` | Open/goto URL; wait for load (`wait_until`, `timeout_ms`, `headed`) |
| `browser_snapshot` | Accessibility tree + actionable `ref=eN` |
| `browser_click` / `browser_type` / `browser_press` | Act by CSS/role selector or snapshot ref |
| `browser_screenshot` | PNG → **vision** multimodal tool result |
| `browser_console` | Recent console messages / errors |
| `browser_network` | Recent request/response summary |
| `browser_close` | Close page/context for this agent session |

### Session behavior

- One Chromium context per agent cwd + session id (process-local manager).
- **Headless by default.** Pass `headed: true` on `browser_navigate` when a
  display is available. Switching headed ↔ headless recycles the browser.
- Snapshot refs for duplicate role+name pairs use Playwright
  `>> nth=N` so `e1` / `e2` stay unambiguous.
- Long `vite` / `next dev` / builds should use **jobs / PTY** (`bash`
  background, `job_*`, `terminal_*`) — do not block the turn on the server.

## Skills

Bundled under `packages/envoy-harness/skills/` (package skill root
`package:envoy`):

| Skill | When |
|---|---|
| `vite-react` | Vite + React HMR / Vitest / Playwright e2e |
| `nextjs` | App Router, `next dev` / `next build` |
| `frontend-debug` | Generic SPA / static / Storybook loop |

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
`browser-debug` (`preferred_peer_id` or capability tag). Helpers:
`src/web/browser-worker.ts`. Adapter skill mapping:
`@envoymesh/envoy-harness-adapter` → `browser-debug`.

See also [`distributed-collaboration.md`](./distributed-collaboration.md) §1.3.

## Smoke test

```bash
ENVOY_WEB_SMOKE=1 pnpm --filter @envoymesh/envoy-harness test test/web/smoke.test.ts
```

## Out of scope (v1)

- Replacing Cursor’s IDE MCP Playwright (builtins are for the harness agent loop)
- Cloud browser farms / full Lighthouse CI productization
- Appium / Selenium stacks
