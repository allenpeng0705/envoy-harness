/**
 * `envoy-harness self-evolve` argv parser.
 */

import { ArgvError, type SelfEvolveParsedArgs } from "./argv-types.js";
import { handleCommonFlag } from "./argv-common.js";

/** v0 flag set for the `self-evolve` subcommand. */
const SELF_EVOLVE_FLAGS = new Set([
  "--help",
  "--version",
  "--model",
  "--provider",
  "--scoreboard",
  "--snapshot-dir",
  "--benchmark",
  "--ruleset",
  "--agents-md",
  "--adoptions",
  "--commit",
  "--recent-failures",
  "--pull",
  "--peer-id",
  "--no-color",
  "--verbose",
  "--quiet",
]);

/** A flag that takes a value for the self-evolve subcommand. */
const SELF_EVOLVE_VALUED_FLAGS = new Set([
  "--model",
  "--provider",
  "--scoreboard",
  "--snapshot-dir",
  "--benchmark",
  "--ruleset",
  "--agents-md",
  "--adoptions",
  "--recent-failures",
  "--peer-id",
]);

// ---------------------------------------------------------------------------
// self-evolve subcommand
// ---------------------------------------------------------------------------

export function parseSelfEvolveArgs(argv: ReadonlyArray<string>): SelfEvolveParsedArgs {
  const out: SelfEvolveParsedArgs = {
    subcommand: "self-evolve",
    help: false,
    version: false,
    model: undefined,
    provider: undefined,
    scoreboard: undefined,
    snapshotDir: undefined,
    benchmark: undefined,
    ruleset: undefined,
    agentsMd: undefined,
    adoptions: undefined,
    commit: false,
    recentFailures: undefined,
    pull: false,
    peerId: undefined,
    noColor: false,
    verbose: false,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      if (!SELF_EVOLVE_FLAGS.has(arg)) {
        throw new ArgvError(`unknown flag: ${arg}`);
      }
      if (handleCommonFlag(arg, out)) continue;
      if (arg === "--commit") {
        out.commit = true;
        continue;
      }
      if (arg === "--pull") {
        out.pull = true;
        continue;
      }
      if (SELF_EVOLVE_VALUED_FLAGS.has(arg)) {
        const value = argv[++i];
        if (value === undefined) {
          throw new ArgvError(`${arg} requires a value`);
        }
        switch (arg) {
          case "--model":
            out.model = value;
            break;
          case "--provider":
            out.provider = value;
            break;
          case "--scoreboard":
            out.scoreboard = value;
            break;
          case "--snapshot-dir":
            out.snapshotDir = value;
            break;
          case "--benchmark":
            out.benchmark = value;
            break;
          case "--ruleset":
            out.ruleset = value;
            break;
          case "--agents-md":
            out.agentsMd = value;
            break;
          case "--adoptions":
            out.adoptions = value;
            break;
          case "--recent-failures": {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0) {
              throw new ArgvError(`invalid --recent-failures: ${value}`);
            }
            out.recentFailures = n;
            break;
          }
          case "--peer-id":
            out.peerId = value;
            break;
        }
        continue;
      }
      throw new ArgvError(`unhandled flag: ${arg}`);
    }
    // For self-evolve, the only non-flag positional is the
    // subcommand keyword itself ("self-evolve"), which we've
    // already used to dispatch. Anything else is an error.
    if (arg !== "self-evolve") {
      throw new ArgvError(`unexpected positional: ${arg}`);
    }
  }
  return out;
}
