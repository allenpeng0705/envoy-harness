/**
 * Live-test lane helpers (T3.6).
 *
 * **What this file is for:** the `test/live/*.test.ts` files
 * make real network calls to the configured LLM provider
 * (OpenAI / Anthropic / DeepSeek). They are off by default
 * — they only run when the developer opts in via
 * `RUN_LIVE_TESTS=1` AND the provider's API key env var is
 * set. CI never runs them (no `RUN_LIVE_TESTS` in CI env).
 *
 * **Why a `liveDescribe` helper:** the skip logic is the
 * same in all 3 files (RUN_LIVE_TESTS=1 AND `envVar`
 * non-empty). Hoisting it into one helper keeps each test
 * file to 1 line of setup, and the skip message ("no
 * `OPENAI_API_KEY` env var") shows up consistently in the
 * skipped-test list.
 *
 * **Why not a `vitest.config.ts` `exclude` rule:** the
 * live tests need to be discoverable so `pnpm test:live`
 * can run them. The skip pattern at describe-time keeps
 * them in the test graph (so the test list shows them
 * as "skipped" — explicit, not silent) and the dedicated
 * `test:live` script can focus on the path.
 *
 * **Stability:** this is test-only code. The public API
 * surface is `liveDescribe`; callers import from
 * `./helpers.js`. The helper is the only thing other live
 * files import; no `*.test.ts` file imports from another
 * `*.test.ts` file.
 */

import { describe, type SuiteFactory } from "vitest";

/**
 * Run `fn` as a `describe` block IFF
 * `process.env.RUN_LIVE_TESTS === "1"` AND
 * `process.env[envVar]` is a non-empty string. Otherwise
 * the block is registered with `describe.skip`, which
 * shows up in the test output as "skipped" — explicit,
 * not silent.
 *
 * @param name - The describe block name. Include the
 *   provider name + a short purpose (e.g. "OpenAI live
 *   — simple completion").
 * @param envVar - The API key env var name. One of
 *   `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
 *   `DEEPSEEK_API_KEY`. The skip message names it so
 *   the developer knows what to set.
 * @param fn - The describe body (the actual `it` calls).
 */
export function liveDescribe(
  name: string,
  envVar: string,
  fn: SuiteFactory,
): void {
  const live = process.env["RUN_LIVE_TESTS"] === "1";
  const key = process.env[envVar];
  const hasKey = typeof key === "string" && key.length > 0;
  const runner = live && hasKey ? describe : describe.skip;
  if (live && !hasKey) {
    // Annotate the skip so the developer sees which env
    // var is missing in the `pnpm test:live` output.
    // We can't change the describe label mid-call, so we
    // log once per file (the describe fn only runs once
    // even when skipped).
    // eslint-disable-next-line no-console
    console.warn(
      `[live] ${name}: skipping (set ${envVar} to enable this test)`,
    );
  }
  runner(name, fn);
}
