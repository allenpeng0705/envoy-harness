---
name: nextjs
description: Debug and ship Next.js apps with browser_* tools, next dev/build, and background jobs.
when-to-use: When working on a Next.js project (next.config / app router), fixing UI bugs with screenshots, or verifying App Router pages in the browser.
---

# Next.js loop

## Prerequisites

- Use `--permission-preset webdev` (or `/preset webdev`) so `.next` / Playwright caches and `browser_*` tools are allowed.
- Install Playwright once on the host: `npm i playwright && npx playwright install chromium`.
- Long `next dev` / `next build`: prefer background jobs / `job_*` / PTY.

## Standard loop

1. From the project root: `npm install` if needed, then start `npm run dev` / `npx next dev` in a **background job**.
2. Read the job output for the local URL (usually `http://localhost:3000`).
3. `browser_navigate` to the route under test (App Router paths under `app/`).
4. After UI edits: `browser_snapshot` → act → `browser_screenshot` (vision).
5. On regressions: `browser_console` and `browser_network` (watch RSC / `_next` failures).
6. Production check: `npm run build` (or `next build`) in a job; optionally `next start` and re-verify in the browser.
7. `browser_close` when done.

## Tips

- Prefer App Router conventions (`app/`, `layout.tsx`, `page.tsx`, server vs client components).
- Keep the Next server in a job; clear `.next` only when the cache is corrupt.
- Prefer `browser_screenshot` over guessing layout from source alone.
