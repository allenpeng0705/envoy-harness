---
name: frontend-debug
description: Generic SPA UI debug loop — start a local server in a job, navigate, snapshot→act, screenshot, console/network.
when-to-use: When debugging any local web UI (Vite, Next, CRA, static HTML, Storybook) and you need a browser loop without a stack-specific skill.
---

# Frontend debug loop

## Prerequisites

- `--permission-preset webdev` (or `/preset webdev`) / `ENVOY_WEB_TOOLS=1`.
- Playwright + Chromium installed for `browser_*`.
- Dev servers and builds run as **background jobs**.

## Standard loop

1. Identify how to serve the app (`npm run dev`, `npx serve dist`, Storybook, etc.) and start it in a job.
2. `browser_navigate` to the local URL.
3. Reproduce the bug: `browser_snapshot` → `browser_click` / `browser_type` / `browser_press`.
4. Capture evidence: `browser_screenshot` (vision), `browser_console`, `browser_network`.
5. Edit source with `read_file` / `edit` / `write`, wait for HMR or refresh via `browser_navigate`, re-verify.
6. `browser_close` when finished.

## Tips

- Prefer snapshot refs over brittle absolute CSS when the tree is stable.
- Do not block the agent turn waiting on a long-lived server — use jobs.
- For remote browser hosts, route via mesh capability `browser-worker` / skill `browser-debug`.
