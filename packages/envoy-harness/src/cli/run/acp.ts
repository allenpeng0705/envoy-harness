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

  const { backend, dispose: disposeBackend } = resolveAcpBackend(
    parsed,
    options,
    stderr,
  );
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
    await disposeBackend().catch(() => undefined);
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
): {
  backend: ProtocolSessionBackend;
  /**
   * Dispose the backend's environment (jobs / terminals / credentials).
   * Always a no-op for the demo backend and for an injected
   * `options.protocolBackend` (caller owns disposal).
   */
  dispose: () => Promise<void>;
} {
  if (options.protocolBackend !== undefined) {
    return {
      backend: options.protocolBackend,
      dispose: async () => undefined,
    };
  }

  const model = resolveLiveModel(parsed, options);
  if (model !== undefined) {
    const defaultCwd = parsed.cwd ?? options.cwd ?? process.cwd();
    // Build the tool registry + environment ONCE for the whole
    // ACP server. Building them inside the createAgent factory
    // (one call per session) leaks jobs / terminals / web
    // providers across sessions, because the env's `dispose()`
    // is never reached. The shared registry is safe to reuse:
    // jobs and terminals are owner-fenced by `session.id`, so
    // two sessions can never see each other's resources.
    const tools = new ToolRegistry();
    for (const t of BUILTIN_TOOLS) tools.register(t);
    const env = wireEnvironmentTools(tools);
    return {
      backend: createAgentSessionBackend({
        defaultCwd,
        // U2 — the status bar reads the model label from config/get.
        getConfig: () => ({
          version: "0.0.0",
          ...(parsed.model !== undefined
            ? { model: parsed.model }
            : parsed.provider !== undefined
              ? { model: parsed.provider }
              : {}),
        }),
        createAgent: ({ sessionId, cwd, askHandler }) => {
          const hooks = new HookRegistry();
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
      }),
      async dispose() {
        await env.dispose().catch(() => undefined);
      },
    };
  }

  if (!parsed.quiet) {
    stderr.write(
      "envoy-harness: --acp using demo backend (pass --provider <name> or inject RunOptions.model for a live Agent)\n",
    );
  }
  return {
    backend: createFakeSessionBackend(),
    dispose: async () => undefined,
  };
}
