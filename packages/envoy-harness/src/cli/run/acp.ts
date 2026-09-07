/**
 * Phase E / G — `--acp` stdio server dispatch.
 *
 * Serves the ACP dialect on stdin/stdout with Content-Length
 * JSON-RPC framing. Hosts (TUI, EnvoyMesh Tauri) attach as
 * clients; stdout is reserved for frames (status → stderr).
 */

import type { Readable, Writable } from "node:stream";
import * as path from "node:path";

import {
  Agent,
  attachAcpServer,
  BUILTIN_TOOLS,
  buildAgentSystemPrompt,
  createAgentSessionBackend,
  createFakeSessionBackend,
  HookRegistry,
  InMemorySession,
  JsonRpcConnection,
  LocalMemoryStore,
  SessionStore,
  ToolRegistry,
  wireEnvironmentTools,
  wireMcpClientsFromConfig,
  type ModelAdapter,
  loadConfigStack,
  resolveAgentRuntimeConfig,
  systemPromptOptionsFromConfig,
  type ProtocolSessionBackend,
} from "../../index.js";
import type { ParsedArgs } from "../argv.js";
import { wireCordisExtensions } from "../../cordis/wire-from-config.js";
import { CliError } from "./errors.js";
import { makeEmptyRunResult, resolveModel, defaultSessionDir } from "./helpers.js";
import { EXIT_USAGE, type RunOptions, type RunResult } from "./types.js";
import { mergeClusterSeams, wirePeerCluster } from "../../peers/wire-cluster.js";
import { buildCliLocalMeshSubmitter } from "./build-local-mesh-submitter.js";

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

  const { backend, dispose: disposeBackend } = await resolveAcpBackend(
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

async function resolveAcpBackend(
  parsed: Extract<ParsedArgs, { subcommand: "run" }>,
  options: RunOptions,
  stderr: NodeJS.WritableStream,
): Promise<{
  backend: ProtocolSessionBackend;
  /**
   * Dispose the backend's environment (jobs / terminals / credentials).
   * Always a no-op for the demo backend and for an injected
   * `options.protocolBackend` (caller owns disposal).
   */
  dispose: () => Promise<void>;
}> {
  if (options.protocolBackend !== undefined) {
    return {
      backend: options.protocolBackend,
      dispose: async () => undefined,
    };
  }

  const defaultCwdEarly = parsed.cwd ?? options.cwd ?? process.cwd();
  const { layer: configLayer } = await loadConfigStack({
    cwd: defaultCwdEarly,
    ...(parsed.config !== undefined ? { filePath: parsed.config } : {}),
  });
  const { resolvePeerEndpoints } = await import("../../peers/resolve.js");
  const peerEndpoints = resolvePeerEndpoints({
    configLayer,
    cliPeers: parsed.peers,
  });

  let clusterDispose: (() => Promise<void>) | undefined;
  const wireCluster = async (backend: ProtocolSessionBackend): Promise<ProtocolSessionBackend> => {
    if (peerEndpoints.length === 0) return backend;
    try {
      const wired = await wirePeerCluster({
        peers: peerEndpoints,
        discovery: parsed.discovery,
        ...(parsed.peerConnectTimeoutMs !== undefined
          ? { connectTimeoutMs: parsed.peerConnectTimeoutMs }
          : {}),
        onFailure: (id, err) => {
          if (!parsed.quiet) {
            stderr.write(`envoy-harness: peer ${id} failed: ${err.message}\n`);
          }
        },
      });
      if (wired === undefined) return backend;
      clusterDispose = wired.dispose;
      return mergeClusterSeams(backend, wired.seams);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CliError(message, EXIT_USAGE);
    }
  };

  const model = resolveLiveModel(parsed, options);
  if (model !== undefined) {
    const defaultCwd = defaultCwdEarly;
    // Build the tool registry + environment ONCE for the whole
    // ACP server. Building them inside the createAgent factory
    // (one call per session) leaks jobs / terminals / web
    // providers across sessions, because the env's `dispose()`
    // is never reached. The shared registry is safe to reuse:
    // jobs and terminals are owner-fenced by `session.id`, so
    // two sessions can never see each other's resources.
    const tools = new ToolRegistry();
    for (const t of BUILTIN_TOOLS) tools.register(t);
    const mcpWire = await wireMcpClientsFromConfig(
      configLayer.mcpServers,
      tools,
    );
    const env = wireEnvironmentTools(tools, {
      ...(options.skills !== undefined ? { skills: options.skills } : {}),
    });
    const cordisWire = await wireCordisExtensions({
      plugins: configLayer.cordisPlugins,
      cwd: defaultCwd,
      tools,
      environment: env,
    });
    const jobRegistry = cordisWire.jobs;
    const memoryStore = new LocalMemoryStore({
      memoryRoot:
        process.env["ENVOY_MEMORY_DIR"] ??
        path.join(defaultCwd, "memories"),
    });
    const runtime = resolveAgentRuntimeConfig(defaultCwd, configLayer, {
      permissionMode: parsed.sandbox ?? "workspace-write",
      ...(parsed.approval !== undefined
        ? {
            askForApproval: parsed.approval as
              | "unless-trusted"
              | "on-request"
              | "granular"
              | "never",
          }
        : {}),
    });
    const systemPrompt = await buildAgentSystemPrompt({
      cwd: defaultCwd,
      ...systemPromptOptionsFromConfig(configLayer),
      permissionMode: runtime.permissionMode,
      askForApproval: runtime.askForApproval,
      plan: parsed.plan === true,
    });
    return {
      backend: await wireCluster(
        createAgentSessionBackend({
          defaultCwd,
          memoryStore,
          // U2 — the status bar reads the model label from config/get.
          getConfig: () => ({
            version: "0.0.0",
            ...(parsed.model !== undefined
              ? { model: parsed.model }
              : parsed.provider !== undefined
                ? { model: parsed.provider }
                : {}),
            ...(parsed.provider !== undefined
              ? { provider: parsed.provider }
              : {}),
            ...(parsed.baseUrl !== undefined
              ? { baseUrl: parsed.baseUrl }
              : {}),
          }),
          listTools: () =>
            tools.list().map((t) => ({
              name: t.name,
              description: t.description,
            })),
          createAgent: ({
            sessionId,
            cwd,
            askHandler,
            session,
            userQuestions,
          }) => {
            const sessionCwd = cwd ?? defaultCwd;
            const hooks = new HookRegistry();
            return new Agent({
              model,
              tools,
              hooks,
              session:
                session ??
                new InMemorySession(sessionId, {
                  cwd: sessionCwd,
                  permissionMode: runtime.permissionMode,
                  startedAt: new Date().toISOString(),
                }),
              cwd: sessionCwd,
              askHandler,
              systemPrompt,
              approval: runtime.askForApproval,
              sandboxPolicy: runtime.sandboxPolicy,
              memoryStore,
              skills: env.skills,
              ...(configLayer.shellEnvironmentPolicy !== undefined
                ? {
                    shellEnvironmentPolicy:
                      configLayer.shellEnvironmentPolicy,
                  }
                : {}),
              jobRegistry,
              terminalService: env.terminals,
              ...(mcpWire !== undefined ? { mcpClients: mcpWire.registry } : {}),
              ...(parsed.maxTurns !== undefined
                ? { maxIterations: parsed.maxTurns }
                : {}),
              ...(parsed.maxCostUsd !== undefined
                ? { maxCostUsd: parsed.maxCostUsd }
                : {}),
              // R4.1 — host-bridged via session/user_question (TUI answers).
              userQuestions,
              // R8.1 — default LocalMeshSubmitter unless --no-subagents.
              ...(!parsed.noSubagents
                ? {
                    meshSubmitter: buildCliLocalMeshSubmitter({
                      model,
                      cwd: sessionCwd,
                      permissionMode: runtime.permissionMode,
                      parentSessionId: sessionId,
                    }),
                  }
                : {}),
            });
          },
          sessionStore: new SessionStore({
            dir: parsed.sessionDir ?? defaultSessionDir(parsed),
          }),
        }),
      ),
      async dispose() {
        if (mcpWire !== undefined) {
          await mcpWire.dispose().catch(() => undefined);
        }
        if (cordisWire.cordisDispose !== undefined) {
          await cordisWire.cordisDispose().catch(() => undefined);
        }
        await env.dispose().catch(() => undefined);
        if (clusterDispose !== undefined) {
          await clusterDispose().catch(() => undefined);
        }
      },
    };
  }

  if (!parsed.quiet) {
    stderr.write(
      "envoy-harness: --acp using demo backend (pass --provider <name> or inject RunOptions.model for a live Agent)\n",
    );
  }
  return {
    backend: await wireCluster(createFakeSessionBackend()),
    dispose: async () => {
      if (clusterDispose !== undefined) {
        await clusterDispose().catch(() => undefined);
      }
    },
  };
}
