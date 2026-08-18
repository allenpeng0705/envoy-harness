#!/usr/bin/env -S npx tsx
/**
 * envoy-harness — the CLI binary.
 *
 * **Phase 1 limitation:** there's no built-in model adapter. The
 * binary throws with a useful message if no model is wired. Real
 * adapters (OpenAI / Anthropic / DeepSeek) land in the LLM
 * package, which is a separate concern. For now, this binary
 * proves the CLI plumbing (argv, prompt, agent loop, exit codes).
 *
 * **Usage:** see `src/cli/argv.ts` `formatHelp` for the full
 * surface, or run `envoy-harness --help`.
 *
 * **Stdin:** if the first positional is `-`, the prompt is read
 * from stdin. Useful for `echo "..." | envoy-harness -`.
 *
 * **Running:** the shebang uses `npx tsx` so this script runs
 * directly from source. After `pnpm run build`, the produced
 * `dist/` is also self-contained.
 */

import {
  CliError,
  run,
  type ExitCode,
} from "../src/index.js";

async function main(): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`envoy-harness: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    // Unknown error: full stack.
    process.stderr.write(`envoy-harness: internal error: ${(err as Error).message}\n`);
    if ((err as Error).stack) {
      process.stderr.write(`${(err as Error).stack}\n`);
    }
    process.exit(1 satisfies ExitCode);
  }
}

void main();
