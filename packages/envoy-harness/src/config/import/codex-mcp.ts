/**
 * Codex / envoy `mcp_servers` table parser → `ConfigLayer.mcpServers`.
 */

import type { ConfigLayer } from "../schema.js";
import { ConfigLoadError } from "../loader.js";

type McpServerConfig = NonNullable<ConfigLayer["mcpServers"]>[number];

function normalizeEntry(
  value: unknown,
  fallbackName?: string,
): McpServerConfig | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const name =
    typeof o.name === "string" && o.name.length > 0
      ? o.name
      : fallbackName;
  if (name === undefined || typeof o.command !== "string") {
    return undefined;
  }
  const entry: McpServerConfig = { name, command: o.command };
  if (Array.isArray(o.args)) {
    if (!o.args.every((a) => typeof a === "string")) {
      return undefined;
    }
    entry.args = o.args as string[];
  }
  if (
    o.env !== null &&
    typeof o.env === "object" &&
    !Array.isArray(o.env)
  ) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
      if (typeof v === "string") env[k] = v;
    }
    if (Object.keys(env).length > 0) entry.env = env;
  }
  return entry;
}

/**
 * Accept codex array tables (`[[mcp_servers]]`) or map form
 * (`[mcp_servers.github]`).
 */
export function parseCodexMcpServers(
  raw: unknown,
  sourcePath: string,
): McpServerConfig[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) {
    const out: McpServerConfig[] = [];
    for (const item of raw) {
      const entry = normalizeEntry(item);
      if (entry === undefined) {
        throw new ConfigLoadError(
          `invalid codex config: ${sourcePath}: mcp_servers entry requires name + command`,
          sourcePath,
        );
      }
      out.push(entry);
    }
    return out;
  }
  if (typeof raw === "object" && raw !== null) {
    const out: McpServerConfig[] = [];
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = normalizeEntry(value, name);
      if (entry === undefined) {
        throw new ConfigLoadError(
          `invalid codex config: ${sourcePath}: mcp_servers.${name} requires command`,
          sourcePath,
        );
      }
      out.push(entry);
    }
    return out;
  }
  throw new ConfigLoadError(
    `invalid codex config: ${sourcePath}: mcp_servers must be an array or table`,
    sourcePath,
  );
}
