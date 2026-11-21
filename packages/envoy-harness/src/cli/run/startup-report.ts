/**
 * Shared startup diagnostics for doctor + --verbose boot banners.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadConfigStack } from "../../config/layers.js";
import { resolveDefaultSessionDir } from "./helpers.js";

export interface StartupReport {
  platform: string;
  arch: string;
  node: string;
  cwd: string;
  sources: ReadonlyArray<string>;
  ignoredProjectKeys: ReadonlyArray<string>;
  mcpServerCount: number;
  pluginAllowCount: number;
  cordisPluginCount: number;
  sessionDir: string;
  sandboxExecutorFlag: string | undefined;
}

export async function collectStartupReport(opts: {
  config?: string;
  cwd?: string;
  sessionDir?: string;
  sandboxExecutor?: string;
}): Promise<StartupReport> {
  const cwd = opts.cwd ?? process.cwd();
  let sources: string[] = [];
  let ignoredProjectKeys: string[] = [];
  let mcpServerCount = 0;
  let pluginAllowCount = 0;
  let cordisPluginCount = 0;
  try {
    const stack = await loadConfigStack({
      cwd,
      ...(opts.config !== undefined ? { filePath: opts.config } : {}),
    });
    sources = [...stack.sources];
    ignoredProjectKeys = [...stack.ignoredProjectKeys];
    mcpServerCount = stack.layer.mcpServers?.length ?? 0;
    pluginAllowCount = stack.layer.plugins?.allow?.length ?? 0;
    cordisPluginCount = stack.layer.cordisPlugins?.length ?? 0;
  } catch {
    // leave zeros; caller may still print platform
  }

  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cwd,
    sources,
    ignoredProjectKeys,
    mcpServerCount,
    pluginAllowCount,
    cordisPluginCount,
    sessionDir: opts.sessionDir ?? resolveDefaultSessionDir(),
    sandboxExecutorFlag: opts.sandboxExecutor,
  };
}

export function formatStartupReport(report: StartupReport): string {
  const lines = [
    `startup: ${report.platform}/${report.arch} node ${report.node}`,
    `cwd: ${report.cwd}`,
    `config sources: ${report.sources.length === 0 ? "(none)" : report.sources.join(" → ")}`,
    `mcp=${report.mcpServerCount} plugins.allow=${report.pluginAllowCount} cordis=${report.cordisPluginCount}`,
    `session_dir: ${report.sessionDir}`,
  ];
  if (report.sandboxExecutorFlag !== undefined) {
    lines.push(`sandbox-executor: ${report.sandboxExecutorFlag}`);
  }
  if (report.ignoredProjectKeys.length > 0) {
    lines.push(
      `ignored project keys: ${report.ignoredProjectKeys.join(", ")}`,
    );
  }
  return lines.join("\n");
}

/** Persist a short failure report under the state dir (XDG / LOCALAPPDATA). */
export function writeStartupFailureLog(
  err: unknown,
  sessionDir?: string,
): string {
  const base =
    sessionDir ??
    process.env["LOCALAPPDATA"] ??
    process.env["XDG_STATE_HOME"] ??
    path.join(os.homedir(), ".local", "state");
  const dir = path.join(
    typeof sessionDir === "string" && sessionDir.length > 0
      ? path.dirname(sessionDir)
      : path.join(base, "envoy-harness"),
    "logs",
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `startup-failure-${Date.now()}.log`);
  const body = [
    new Date().toISOString(),
    err instanceof Error ? err.stack ?? err.message : String(err),
    "",
  ].join("\n");
  fs.writeFileSync(file, body, "utf8");
  return file;
}
