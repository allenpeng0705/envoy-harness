/**
 * `envoy-harness doctor` — lightweight health checks (codex doctor parity).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadConfig, resolveConfigPath } from "../../config/index.js";
import { isPtyAvailable } from "../../terminal/pty-backend.js";
import type { ParsedArgs } from "../argv.js";
import type { DoctorRunResult, RunOptions } from "./types.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctorChecks(
  parsed: Extract<ParsedArgs, { subcommand: "doctor" }>,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "node",
    ok: true,
    detail: process.version,
  });

  const configPath = resolveConfigPath(parsed.config);
  checks.push({
    name: "config",
    ok: fs.existsSync(configPath),
    detail: configPath,
  });

  try {
    const { layer } = await loadConfig(
      parsed.config !== undefined ? { filePath: parsed.config } : {},
    );
    const mcpCount = layer.mcpServers?.length ?? 0;
    checks.push({
      name: "mcp_servers",
      ok: true,
      detail: `${mcpCount} configured`,
    });
  } catch (err) {
    checks.push({
      name: "config_parse",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    execFileSync("git", ["--version"], { encoding: "utf8" });
    checks.push({ name: "git", ok: true, detail: "available" });
  } catch {
    checks.push({ name: "git", ok: false, detail: "not found on PATH" });
  }

  checks.push({
    name: "pty",
    ok: isPtyAvailable(),
    detail: isPtyAvailable() ? "node-pty loadable" : "fake terminal only",
  });

  const home = os.homedir();
  const sessionDir = path.join(home, ".local", "share", "envoy-harness", "sessions");
  checks.push({
    name: "session_dir",
    ok: fs.existsSync(sessionDir) || true,
    detail: sessionDir,
  });

  return checks;
}

export async function runDoctorDispatch(
  parsed: Extract<ParsedArgs, { subcommand: "doctor" }>,
  _options: RunOptions,
  stdout: NodeJS.WritableStream,
): Promise<DoctorRunResult> {
  const checks = await runDoctorChecks(parsed);
  stdout.write("envoy-harness doctor\n");
  for (const check of checks) {
    const mark = check.ok ? "ok" : "FAIL";
    stdout.write(`  [${mark}] ${check.name}: ${check.detail}\n`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  stdout.write(
    failed === 0
      ? "all checks passed\n"
      : `${failed} check(s) failed\n`,
  );
  return { subcommand: "doctor", checks };
}
