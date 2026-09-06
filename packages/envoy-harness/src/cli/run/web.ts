/**
 * `envoy-harness web` — delegate to `@envoymesh/envoy-harness-web`.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ParsedArgs } from "../argv.js";
import { CliError } from "./errors.js";
import { EXIT_USAGE } from "./types.js";

const WEB_FORWARD_FLAGS = new Set([
  "--port",
  "--host",
  "--cwd",
  "--provider",
  "--model",
  "--persist",
  "--no-subagents",
  "--peers",
  "--dev",
  "--no-open",
  "--help",
  "-h",
]);

export function resolveWebEntry(forwardArgv: readonly string[]): {
  command: string;
  args: string[];
} {
  if (process.env.ENVOY_HARNESS_WEB_BIN !== undefined) {
    return {
      command: process.env.ENVOY_HARNESS_WEB_BIN,
      args: [...forwardArgv],
    };
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const siblingTs = path.resolve(
    here,
    "../../../../envoy-harness-web/src/server/bin.ts",
  );
  if (existsSync(siblingTs)) {
    return {
      command: process.execPath,
      args: ["--import", "tsx", siblingTs, ...forwardArgv],
    };
  }

  const siblingBin = path.resolve(
    here,
    "../../../../envoy-harness-web/dist/server/bin.js",
  );
  if (existsSync(siblingBin)) {
    return {
      command: process.execPath,
      args: [siblingBin, ...forwardArgv],
    };
  }

  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("@envoymesh/envoy-harness-web/package.json");
    const bin = path.join(path.dirname(pkgJson), "dist/server/bin.js");
    if (existsSync(bin)) {
      return {
        command: process.execPath,
        args: [bin, ...forwardArgv],
      };
    }
  } catch {
    // optional package not installed
  }

  return {
    command: "envoy-harness-web",
    args: [...forwardArgv],
  };
}

function buildForwardArgv(
  _parsed: Extract<ParsedArgs, { subcommand: "web" }>,
  rawArgv: readonly string[],
): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i];
    if (arg === undefined || arg === "web") continue;
    if (!WEB_FORWARD_FLAGS.has(arg)) {
      throw new CliError(`unknown flag for web subcommand: ${arg}`, EXIT_USAGE);
    }
    if (arg === "--help" || arg === "-h") {
      out.push("--help");
      continue;
    }
    if (
      arg === "--persist" ||
      arg === "--no-subagents" ||
      arg === "--dev" ||
      arg === "--no-open"
    ) {
      out.push(arg);
      continue;
    }
    out.push(arg);
    if (
      arg === "--port" ||
      arg === "--host" ||
      arg === "--cwd" ||
      arg === "--provider" ||
      arg === "--model" ||
      arg === "--peers"
    ) {
      const val = rawArgv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new CliError(`${arg} requires a value`, EXIT_USAGE);
      }
      out.push(val);
      i++;
    }
  }
  return out;
}

export async function runWebDispatch(
  parsed: Extract<ParsedArgs, { subcommand: "web" }>,
  rawArgv: readonly string[],
): Promise<{ subcommand: "web" }> {
  const forward = buildForwardArgv(parsed, rawArgv);
  const { command, args } = resolveWebEntry(forward);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new CliError(
            "envoy-harness-web not found. Install @envoymesh/envoy-harness-web " +
              "(or use the monorepo packages/envoy-harness-web)",
            EXIT_USAGE,
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        process.exitCode = code;
      }
      resolve();
    });
  });

  return { subcommand: "web" };
}
