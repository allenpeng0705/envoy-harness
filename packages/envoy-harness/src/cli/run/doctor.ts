/**
 * `envoy-harness doctor` — lightweight health checks (codex doctor parity).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadConfig, resolveConfigPath } from "../../config/index.js";
import {
  isWindowsSidecarAvailable,
  LandlockSandboxExecutor,
  resolveSandboxExecutor,
  SeatbeltSandboxExecutor,
} from "../../sandbox/index.js";
import { isPtyAvailable } from "../../terminal/pty-backend.js";
import type { ParsedArgs } from "../argv.js";
import type { DoctorRunResult, RunOptions } from "./types.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Format the win32 `windows_sandbox` doctor row (F2a vs F2b detail). */
export function windowsSandboxDoctorCheck(opts: {
  probeOk: boolean;
  sidecarAvailable: boolean;
  stderr: string;
  exitCode: number;
}): DoctorCheck {
  if (opts.probeOk) {
    return {
      name: "windows_sandbox",
      ok: true,
      detail: opts.sidecarAvailable
        ? "F2b sidecar probe ok (echo)"
        : "F2a job-object probe ok (echo)",
    };
  }
  return {
    name: "windows_sandbox",
    ok: false,
    detail: opts.stderr.trim() || `exit ${opts.exitCode}`,
  };
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

  if (process.platform === "linux") {
    const landlock = new LandlockSandboxExecutor({ onUnusable: "noop" });
    const probe = await landlock.execute("echo ok", {
      policy: {
        mode: "read-only",
        approval: "on-request",
        backend: "linux-landlock",
        writableRoots: [],
        networkAccess: false,
        slashTmpWritable: true,
      },
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    checks.push({
      name: "landlock",
      ok: probe.exitCode === 0 && !probe.isError,
      detail:
        probe.exitCode === 0
          ? "landlock-run probe ok"
          : probe.stderr.trim() || `exit ${probe.exitCode}`,
    });
  }

  if (process.platform === "darwin") {
    const seatbelt = new SeatbeltSandboxExecutor({ onUnusable: "noop" });
    const probe = await seatbelt.execute("echo ok", {
      policy: {
        mode: "read-only",
        approval: "on-request",
        backend: "darwin-sandbox",
        writableRoots: [],
        networkAccess: false,
        slashTmpWritable: true,
      },
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    checks.push({
      name: "seatbelt",
      ok: probe.exitCode === 0 && !probe.isError,
      detail:
        probe.exitCode === 0
          ? "sandbox-exec probe ok"
          : probe.stderr.trim() || `exit ${probe.exitCode}`,
    });
  }

  if (process.platform === "win32") {
    const winPolicy = {
      mode: "read-only" as const,
      approval: "on-request" as const,
      backend: "windows-sandbox" as const,
      writableRoots: [] as string[],
      networkAccess: false,
      slashTmpWritable: true,
    };
    const exec = resolveSandboxExecutor({
      policy: winPolicy,
      force: "windows-sandbox",
    });
    const probe = await exec.execute("echo ok", {
      policy: winPolicy,
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    const sidecar = isWindowsSidecarAvailable();
    checks.push(
      windowsSandboxDoctorCheck({
        probeOk: probe.exitCode === 0 && !probe.isError,
        sidecarAvailable: sidecar,
        stderr: probe.stderr,
        exitCode: probe.exitCode,
      }),
    );
  } else {
    checks.push({
      name: "windows_sandbox",
      ok: true,
      detail: "skipped (not win32)",
    });
  }

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
