/**
 * @envoymesh/envoy-harness-client — typed stdio client for
 * the ACP + embedding SDK dialects.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { JsonRpcConnection } from "@envoymesh/envoy-harness";

export interface EnvoyHarnessClientOptions {
  input: Readable;
  output: Writable;
  onPermissionRequest?: (req: {
    sessionId: string;
    toolName: string;
    description: string;
    args: unknown;
  }) => Promise<"allow" | "deny">;
  onEvent?: (event: { dialect: "acp" | "sdk"; params: unknown }) => void;
}

export class EnvoyHarnessClient {
  readonly #conn: JsonRpcConnection;
  #dialect: "acp" | "sdk" | undefined;

  constructor(options: EnvoyHarnessClientOptions) {
    this.#conn = new JsonRpcConnection({
      input: options.input,
      output: options.output,
      onRequest: async (method, params) => {
        if (method === "session/request_permission") {
          const req = params as {
            sessionId: string;
            toolName: string;
            description: string;
            args: unknown;
          };
          const decision =
            (await options.onPermissionRequest?.(req)) ?? "deny";
          return { decision };
        }
        throw new Error(`unexpected server request: ${method}`);
      },
      onNotification: (method, params) => {
        if (method === "session/update") {
          options.onEvent?.({ dialect: "acp", params });
        } else if (method === "session/event") {
          options.onEvent?.({ dialect: "sdk", params });
        }
      },
    });
  }

  async initialize(): Promise<{ protocolVersion: number }> {
    this.#dialect = "acp";
    return (await this.#conn.request("initialize", {})) as {
      protocolVersion: number;
    };
  }

  async acpNewSession(params?: {
    cwd?: string;
  }): Promise<{ sessionId: string }> {
    this.#dialect = "acp";
    return (await this.#conn.request("session/new", params ?? {})) as {
      sessionId: string;
    };
  }

  async createSession(params?: {
    cwd?: string;
  }): Promise<{ sessionId: string }> {
    this.#dialect = "sdk";
    return (await this.#conn.request("session/create", params ?? {})) as {
      sessionId: string;
    };
  }

  async prompt(
    sessionId: string,
    text: string,
  ): Promise<{ stopReason: string; messages: unknown[] }> {
    return (await this.#conn.request("session/prompt", {
      sessionId,
      text,
    })) as { stopReason: string; messages: unknown[] };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#conn.request("session/cancel", { sessionId });
  }

  async listTools(): Promise<Array<{ name: string; description: string }>> {
    const res = (await this.#conn.request("tools/list", {})) as {
      tools: Array<{ name: string; description: string }>;
    };
    return res.tools;
  }

  async getConfig(): Promise<Record<string, unknown>> {
    return (await this.#conn.request("config/get", {})) as Record<
      string,
      unknown
    >;
  }

  get dialect(): "acp" | "sdk" | undefined {
    return this.#dialect;
  }

  close(): void {
    this.#conn.close();
  }
}

export { JsonRpcConnection };

export interface SpawnAcpOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stderr?: "inherit" | "pipe" | "ignore";
  onPermissionRequest?: EnvoyHarnessClientOptions["onPermissionRequest"];
  onEvent?: EnvoyHarnessClientOptions["onEvent"];
}

export interface SpawnedAcp {
  client: EnvoyHarnessClient;
  child: ChildProcessWithoutNullStreams;
  close(): void;
}

/** Spawn a harness ACP server and return a typed client over its stdio. */
export function spawnAcpServer(options: SpawnAcpOptions = {}): SpawnedAcp {
  const command = options.command ?? "envoy-harness";
  const args = options.args ?? ["--acp"];
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", options.stderr ?? "inherit"],
  }) as ChildProcessWithoutNullStreams;

  const client = new EnvoyHarnessClient({
    input: child.stdout,
    output: child.stdin,
    ...(options.onPermissionRequest !== undefined
      ? { onPermissionRequest: options.onPermissionRequest }
      : {}),
    ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
  });

  return {
    client,
    child,
    close() {
      client.close();
      if (!child.killed) child.kill();
    },
  };
}
