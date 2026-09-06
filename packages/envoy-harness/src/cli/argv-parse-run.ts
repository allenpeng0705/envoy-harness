/**
 * `envoy-harness run` argv parser.
 */

import { parsePeerEndpoint, parsePeerEndpointsFromEnv } from "../peers/endpoints.js";
import { parsePluginConfigEntry, PluginConfigParseError } from "../plugins/config-parser.js";
import { ArgvError, type RunParsedArgs } from "./argv-types.js";
import { handleCommonFlag, isPermissionMode } from "./argv-common.js";

/** v0 flag set for the `run` subcommand (default). */
const RUN_FLAGS = new Set([
  "--help",
  "--version",
  "--json",
  "--sandbox",
  "--approval",
  "--model",
  "--provider",
  "--cwd",
  "--max-turns",
  "--max-cost-usd",
  "--resume",
  "--resume-remote",
  "--fork",
  "--persist",
  "--session-dir",
  "--config",
  "--import-config",
  "--from",
  "--plugin",
  "--plugin-config",
  "--peers",
  "--peer",
  "--discovery",
  "--connect-timeout-ms",
  "--plan",
  "--repl",
  "--acp",
  "--no-color",
  "--verbose",
  "--quiet",
]);

/** A flag that takes a value (--flag value) for the run subcommand. */
const RUN_VALUED_FLAGS = new Set([
  "--sandbox",
  "--sandbox-executor",
  "--approval",
  "--model",
  "--provider",
  "--cwd",
  "--max-turns",
  "--max-cost-usd",
  "--resume",
  "--resume-remote",
  "--fork",
  "--session-dir",
  "--config",
  "--import-config",
  "--from",
  "--plugin",
  "--plugin-config",
  "--peers",
  "--peer",
  "--discovery",
  "--connect-timeout-ms",
]);

// ---------------------------------------------------------------------------
// run subcommand (default)
// ---------------------------------------------------------------------------

export function parseRunArgs(argv: ReadonlyArray<string>): RunParsedArgs {
  const out: RunParsedArgs = {
    subcommand: "run",
    help: false,
    version: false,
    json: false,
    sandbox: undefined,
    sandboxExecutor: undefined,
    approval: undefined,
    model: undefined,
    provider: undefined,
    cwd: undefined,
    maxTurns: undefined,
    maxCostUsd: undefined,
    resume: undefined,
    resumeRemote: undefined,
    fork: undefined,
    persist: false,
    sessionDir: undefined,
    config: undefined,
    importConfig: undefined,
    importFrom: undefined,
    plugins: [],
    pluginConfigs: [],
    plan: false,
    repl: false,
    acp: false,
    peers: [],
    discovery: "static",
    peerConnectTimeoutMs: undefined,
    noColor: false,
    verbose: false,
    quiet: false,
    positional: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      if (!RUN_FLAGS.has(arg)) {
        throw new ArgvError(`unknown flag: ${arg}`);
      }
      if (handleCommonFlag(arg, out)) continue;
      if (arg === "--json") {
        out.json = true;
        continue;
      }
      if (arg === "--plan") {
        out.plan = true;
        continue;
      }
      if (arg === "--repl") {
        out.repl = true;
        continue;
      }
      if (arg === "--acp") {
        out.acp = true;
        continue;
      }
      if (arg === "--persist") {
        out.persist = true;
        continue;
      }
      // Valued flags: consume the next arg.
      if (RUN_VALUED_FLAGS.has(arg)) {
        const value = argv[++i];
        if (value === undefined) {
          throw new ArgvError(`${arg} requires a value`);
        }
        switch (arg) {
          case "--sandbox":
            if (!isPermissionMode(value)) {
              throw new ArgvError(
                `invalid --sandbox: ${value} (expected read-only | workspace-write | danger-full-access)`,
              );
            }
            out.sandbox = value;
            break;
          case "--sandbox-executor":
            if (
              value !== "landlock" &&
              value !== "seatbelt" &&
              value !== "windows-sandbox" &&
              value !== "none"
            ) {
              throw new ArgvError(
                `invalid --sandbox-executor: ${value} (expected landlock | seatbelt | windows-sandbox | none)`,
              );
            }
            out.sandboxExecutor = value;
            break;
          case "--approval":
            if (
              value !== "unless-trusted" &&
              value !== "on-request" &&
              value !== "granular" &&
              value !== "never"
            ) {
              throw new ArgvError(
                `invalid --approval: ${value} (expected unless-trusted | on-request | granular | never)`,
              );
            }
            out.approval = value;
            break;
          case "--model":
            out.model = value;
            break;
          case "--provider":
            out.provider = value;
            break;
          case "--cwd":
            out.cwd = value;
            break;
          case "--max-turns": {
            const n = Number(value);
            if (!Number.isFinite(n) || n <= 0) {
              throw new ArgvError(`invalid --max-turns: ${value}`);
            }
            out.maxTurns = n;
            break;
          }
          case "--max-cost-usd": {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0) {
              throw new ArgvError(`invalid --max-cost-usd: ${value}`);
            }
            out.maxCostUsd = n;
            break;
          }
          case "--resume":
            out.resume = value;
            break;
          case "--resume-remote":
            out.resumeRemote = value;
            break;
          case "--fork":
            out.fork = value;
            break;
          case "--session-dir":
            out.sessionDir = value;
            break;
          case "--config":
            out.config = value;
            break;
          case "--import-config":
            out.importConfig = value;
            break;
          case "--from":
            out.importFrom = value;
            break;
          case "--plugin":
            out.plugins.push(value);
            break;
          case "--plugin-config":
            try {
              out.pluginConfigs.push(parsePluginConfigEntry(value));
            } catch (err) {
              if (err instanceof PluginConfigParseError) {
                // Re-throw as `ArgvError` so the runner
                // converts to `CliError(EXIT_USAGE)`.
                throw new ArgvError(err.message);
              }
              throw err;
            }
            break;
          case "--peers":
          case "--peer": {
            try {
              out.peers.push(parsePeerEndpoint(value));
            } catch (err) {
              throw new ArgvError((err as Error).message);
            }
            break;
          }
          case "--discovery": {
            if (value !== "static" && value !== "mdns" && value !== "none") {
              throw new ArgvError(
                `invalid --discovery: ${value} (expected static|mdns|none)`,
              );
            }
            out.discovery = value;
            break;
          }
          case "--connect-timeout-ms": {
            const n = Number(value);
            if (!Number.isInteger(n) || n <= 0) {
              throw new ArgvError(`invalid --connect-timeout-ms: ${value}`);
            }
            out.peerConnectTimeoutMs = n;
            break;
          }
        }
        continue;
      }
      // Should be unreachable.
      throw new ArgvError(`unhandled flag: ${arg}`);
    }
    out.positional.push(arg);
  }
  if (out.peers.length === 0) {
    out.peers = [...parsePeerEndpointsFromEnv()];
  }
  return out;
}
