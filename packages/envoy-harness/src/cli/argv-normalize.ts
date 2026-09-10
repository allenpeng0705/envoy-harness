/**
 * argv normalization shared by every envoy binary.
 *
 * **The problem this solves:** package runners
 * (`pnpm <script> -- …`, `npm run <script> -- …`)
 * forward the separator `--` to the child process as a
 * literal argument. On pnpm 10 the documented monorepo
 * form forwards BOTH tokens:
 *
 * ```sh
 * pnpm envoy -- --version
 * # → tsx bin/envoy-harness.ts "--" "--version"
 * ```
 *
 * envoy's parser has no end-of-options semantics (the
 * prompt is a plain positional), so a bare `--` reaches a
 * subcommand parser and fails with
 * `unknown flag: --` — which broke every `pnpm envoy -- …`
 * example in the README, including the primary WebUI
 * quickstart command.
 *
 * **The fix:** drop standalone `--` tokens before parsing.
 * This is safe for envoy's grammar because:
 * - A standalone `--` is never a prompt in practice (a
 *   prompt is either quoted as one argv element, read from
 *   stdin with `-`, or read from a file).
 * - No flag takes `--` as a *value*; `--` inside a quoted
 *   value stays part of that single argv element and is
 *   therefore untouched.
 * - Subcommand detection already skipped `--`
 *   (`argv.ts` filters on `startsWith("--")`), so removing
 *   it cannot change which subcommand is selected.
 *
 * Everything else is passed through verbatim, so an
 * unknown *real* flag still fails loudly.
 */

/** The bare separator token emitted by npm/pnpm/script runners. */
export const RUNNER_SEPARATOR = "--";

/**
 * Remove standalone `--` separator tokens inserted by package
 * runners. Returns a new array; the input is not mutated.
 *
 * Non-string entries and empty strings are dropped as well —
 * `process.argv.slice(2)` can contain `undefined` holes under
 * some runners, and feeding `undefined` to the parsers
 * produces a confusing `unknown flag: undefined`.
 */
export function stripRunnerSeparators(
  argv: ReadonlyArray<string | undefined>,
): string[] {
  const out: string[] = [];
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.length === 0) continue;
    if (arg === RUNNER_SEPARATOR) continue;
    out.push(arg);
  }
  return out;
}
