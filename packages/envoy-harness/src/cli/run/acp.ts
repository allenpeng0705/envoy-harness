/**
 * Phase E / G — `--acp` stdio server dispatch.
 *
 * Serves the ACP dialect on stdin/stdout with Content-Length
 * JSON-RPC framing. Hosts (TUI, EnvoyMesh Tauri) attach as
 * clients; stdout is reserved for frames (status → stderr).
 */

import type { Readable, Writable } from "node:stream";

import {
  Agent,
  attachAcpServer,
  BUILTIN_TOOLS,
  createAgentSessionBackend,
  createFakeSessionBackend,
  HookRegistry,
  InMemorySession,
  JsonRpcConnection,
  ToolRegistry,
  wireEnvironmentTools,
  type ModelAdapter,
  type ProtocolSessionBackend,
} from "../../index.js";
import type { ParsedArgs } from "../argv.js";
import { CliError } from "./errors.js";
import { makeEmptyRunResult, resolveModel } from "./helpers.js";
import { EXIT_USAGE, type RunOptions, type RunResult } from "./types.js";

/**
 * Run until the JSON-RPC input stream ends (or the connection
 * closes). Returns an empty run result.
 */
export async function runAcpDispatch(
  parsed: Extract<ParsedArgs, { subcommand: "run" }>,
  options: RunOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<RunResult> {
  if (parsed.repl) {
    throw new CliError("--acp and --repl are mutually exclusive", EXIT_USAGE);
  }
  if (parsed.positional.length > 0) {
    throw new CliError(
      "--acp takes no positional prompt (hosts send session/prompt)",
      EXIT_USAGE,
    );
  }

  const input: Readable = options.stdin ?? process.stdin;
  // stdout is the RPC channel — do not write human text here.
  // RunOptions uses NodeJS.WritableStream; JsonRpcConnection wants stream.Writable.
  const output = stdout as Writable;

  const backend = resolveAcpBackend(parsed, options, stderr);
  const connection = new JsonRpcConnection({ input, output });
  const dispose = attachAcpServer({
    connection,
    backend,
    serverInfo: { name: "envoy-harness", version: "0.0.0" },
  });

  try {
    await new Promise<void>((resolve) => {
      if (connection.closed) {
        resolve();
        return;
      }
      connection.on("close", () => resolve());
    });
  } finally {
    dispose();
    connection.close();
  }

  return makeEmptyRunResult();
}

/**
 * Prefer a live Agent when the host injects a model or `--provider`
 * is set (same resolution as one-shot). Otherwise use the hermetic
 * demo backend so TUI/CI smoke works without API keys.
 */
function resolveLiveModel(
  parsed: Extract<ParsedArgs, { subcommand: "run" }>,
  options: RunOptions,
): ModelAdapter | undefined {
  if (options.model !== undefined) return options.model;
  if (parsed.provider) return resolveModel(parsed, options);
  return undefined;
}

function resolveAcpBackend(
  parsed: Extract<ParsedArgs, { subcommand: "run" }>,
  options: RunOptions,
  stderr: NodeJS.WritableStream,
): ProtocolSessionBackend {
  if (options.protocolBackend !== undefined) {
    return options.protocolBackend;
  }

  const model = resolveLiveModel(parsed, options);
  if (model !== undefined) {
    const defaultCwd = parsed.cwd ?? options.cwd ?? process.cwd();
    return createAgentSessionBackend({
      defaultCwd,
      createAgent: ({ sessionId, cwd, askHandler }) => {
        const tools = new ToolRegistry();
        for (const t of BUILTIN_TOOLS) tools.register(t);
        wireEnvironmentTools(tools);
        const hooks = options.hooks ?? new HookRegistry();
        return new Agent({
          model,
          tools,
          hooks,
          session: new InMemorySession(sessionId, {
            cwd: cwd ?? defaultCwd,
            startedAt: new Date().toISOString(),
          }),
          cwd: cwd ?? defaultCwd,
          askHandler,
          ...(parsed.maxTurns !== undefined
            ? { maxIterations: parsed.maxTurns }
            : {}),
          ...(parsed.maxCostUsd !== undefined
            ? { maxCostUsd: parsed.maxCostUsd }
            : {}),
        });
      },
    });
  }

  if (!parsed.quiet) {
    stderr.write(
      "envoy-harness: --acp using demo backend (pass --provider <name> or inject RunOptions.model for a live Agent)\n",
    );
  }
  return createFakeSessionBackend();
}
