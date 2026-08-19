/**
 * The default `McpClientRegistry` implementation.
 *
 * v0: a thin wrapper over a `Map` + a
 * `closeAll()` that fans out to every client.
 * The transport (stdio child process + JSON-RPC
 * state machine) lands in a follow-up sub-chunk;
 * today the host injects pre-built `McpClient`
 * instances.
 *
 * **Why a class:** the registry owns the
 * lifecycle. A bare `Map<string, McpClient>`
 * would leak the child processes when the
 * agent is destroyed. `closeAll()` is the
 * single chokepoint.
 */
import type {
  McpClient,
  McpClientRegistry,
  McpTool,
} from "./types.js";

export class DefaultMcpClientRegistry implements McpClientRegistry {
  private readonly clients = new Map<string, McpClient>();

  register(client: McpClient): void {
    if (this.clients.has(client.serverName)) {
      throw new Error(
        `MCP client already registered for server "${client.serverName}"`,
      );
    }
    this.clients.set(client.serverName, client);
  }

  async unregister(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client === undefined) return;
    this.clients.delete(serverName);
    await client.close();
  }

  get(serverName: string): McpClient | undefined {
    return this.clients.get(serverName);
  }

  list(): ReadonlyArray<string> {
    return [...this.clients.keys()];
  }

  /**
   * Collect every tool from every client. The
   * tool name in the returned list is the bare
   * name (the agent prepends `mcp__<server>__`
   * when registering with the model). We return
   * the serverName alongside so the caller can
   * build the namespaced name.
   */
  async collectTools(): Promise<
    ReadonlyArray<McpTool & { readonly serverName: string }>
  > {
    const all: Array<McpTool & { readonly serverName: string }> = [];
    for (const [serverName, client] of this.clients) {
      const tools = await client.listTools();
      for (const tool of tools) {
        all.push({ ...tool, serverName });
      }
    }
    return all;
  }

  async closeAll(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((c) => c.close()));
  }
}
