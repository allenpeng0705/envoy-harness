/**
 * The location of the shared, in-repo verifier benchmark.
 *
 * **Why one shared file.** The self-evolution loop keeps a candidate
 * ruleset only if it strictly improves the score on this benchmark, and
 * the federated layer adopts a peer's candidate only on the strength of
 * the *local* score. If every deployment graded against its own labels,
 * those comparisons would be meaningless. So the yardstick is one frozen
 * file shipped with the harness; an operator who wants a stricter bar
 * adds tasks to it (or passes `--benchmark <path>` for an experiment),
 * but does not fork the set the loop is scored on.
 *
 * Resolved relative to this module, so it works both from `src/` under
 * vitest and from `dist/` in an installed package.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to `benchmarks/verifier-frozen.yaml` in this package. */
export function sharedBenchmarkPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "benchmarks",
    "verifier-frozen.yaml",
  );
}
