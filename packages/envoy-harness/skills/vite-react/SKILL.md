---
name: vite-react
description: Debug and ship Vite + React SPAs with browser_* tools, npm scripts, and background jobs.
when-to-use: When working on a Vite React project (vite.config), fixing UI bugs with screenshots, or iterating on HMR after component edits.
---

# Vite + React loop

## Prerequisites

- Use `--permission-preset webdev` (or `/preset webdev`) so Vite/Next caches and `browser_*` tools are allowed.
- Install Playwright once on the host: `npm i playwright && npx playwright install chromium` (optionalDependency of envoy-harness).
- Long `npm run dev` / builds: prefer `bash` with background jobs / `job_*` / PTY — do not block the turn on the dev server.

## Standard loop

1. From the project root: `npm install` if needed, then start `npm run dev` (or `pnpm dev` / `yarn dev`) in a **background job**.
2. Read the job output for the local URL (usually `http://localhost:5173`).
3. `browser_navigate` to that URL.
4. After UI edits (HMR): `browser_snapshot` → act with `browser_click` / `browser_type` / `browser_press`, then `browser_screenshot` to inspect via vision.
5. On regressions: `browser_console` and `browser_network`.
6. Unit/component tests: `npm test` / Vitest when present. E2E: project Playwright tests if configured.
7. `browser_close` when finished with the session.

## Tips

- Prefer `browser_screenshot` over describing pixels from memory.
- Keep the Vite server in a job; restart only when config / env changes.
- After `browser_snapshot`, prefer `ref=eN` (duplicate labels use `nth`) over brittle CSS.
- Headless by default; pass `headed: true` on `browser_navigate` only when you need a visible window (flipping headed recycles Chromium).
- If Playwright is missing, tool errors name the install commands — do not invent a Selenium stack.
- Full reference: `docs/webdev.md`.
