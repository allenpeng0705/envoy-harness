/**
 * Writable roots + helpers for the `webdev` permission preset
 * (frontend caches + Playwright browser downloads).
 */

import * as os from "node:os";
import * as path from "node:path";

/** Env override that unlocks `browser_*` tools without the webdev preset. */
export const ENVOY_WEB_TOOLS_ENV = "ENVOY_WEB_TOOLS";

/**
 * Typical Vite / Next / SPA build caches and Playwright browser dirs.
 * Expanded into `writableRoots` when `permissionPreset = "webdev"`.
 */
export function webdevWritableRoots(opts: {
  cwd: string;
  homeDir?: string;
}): string[] {
  const home = opts.homeDir ?? os.homedir();
  const xdgCache =
    process.env["XDG_CACHE_HOME"] ?? path.join(home, ".cache");
  return [
    path.join(opts.cwd, "node_modules", ".vite"),
    path.join(opts.cwd, "node_modules", ".cache"),
    path.join(opts.cwd, ".next"),
    path.join(opts.cwd, "dist"),
    path.join(opts.cwd, ".nuxt"),
    path.join(opts.cwd, ".output"),
    path.join(opts.cwd, ".svelte-kit"),
    path.join(opts.cwd, "playwright-report"),
    path.join(opts.cwd, "test-results"),
    path.join(xdgCache, "ms-playwright"),
    path.join(home, "Library", "Caches", "ms-playwright"),
  ];
}

/**
 * True when a root looks like a webdev / Playwright cache path.
 *
 * Deliberately does **not** treat a bare project `dist/` (or generic
 * `test-results/`) as webdev — that would unlock `browser_*` under
 * default workspace-write for unrelated stacks (Rust, Python, etc.).
 * High-signal markers only: Vite/Next/Nuxt/SvelteKit caches and
 * Playwright dirs.
 */
export function isWebdevWritableRoot(root: string): boolean {
  const normalized = root.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/.vite") ||
    normalized.includes("/node_modules/.cache") ||
    normalized.includes("/.next") ||
    normalized.includes("/.nuxt") ||
    normalized.includes("/.output") ||
    normalized.includes("/.svelte-kit") ||
    normalized.includes("/ms-playwright") ||
    normalized.includes("/playwright-report")
  );
}

/**
 * Gate for first-party `browser_*` tools: webdev preset roots,
 * danger-full-access, or explicit `ENVOY_WEB_TOOLS=1`.
 */
export function isWebBrowserAccessAllowed(policy?: {
  mode?: string;
  networkAccess?: boolean;
  writableRoots?: ReadonlyArray<string>;
}): boolean {
  if (process.env[ENVOY_WEB_TOOLS_ENV] === "1") return true;
  if (policy?.mode === "danger-full-access") return true;
  const roots = policy?.writableRoots ?? [];
  if (roots.some((r) => isWebdevWritableRoot(r))) return true;
  return false;
}
