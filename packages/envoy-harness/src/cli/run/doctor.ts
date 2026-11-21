/**
 * `envoy-harness doctor` — lightweight health checks (codex doctor parity).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

import { loadConfig, resolveConfigPath } from "../../config/index.js";
import {
  isWindowsSidecarAvailable,
  LandlockSandboxExecutor,
  resolveSandboxExecutor,
  SeatbeltSandboxExecutor,
} from "../../sandbox/index.js";
import { isPtyAvailable } from "../../terminal/pty-backend.js";
import type { ParsedArgs } from "../argv.js";
import { resolveDefaultSessionDir } from "./helpers.js";
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

  const sessionDir = parsed.sessionDir ?? resolveDefaultSessionDir();
  const sessionDirExists = fs.existsSync(sessionDir);
  checks.push({
    name: "session_dir",
    // Absence is normal before the first `--persist` session, so it is
    // not a failure — but the row must report the REAL path (it
    // previously hard-coded `~/.local/share/...`, a directory the
    // harness never writes to) and say whether it exists yet.
    ok: true,
    detail: sessionDirExists
      ? sessionDir
      : `${sessionDir} (not created yet)`,
  });

  // Wave 1–4 power modules — importability (not a live LLM probe).
  try {
    await import("../../tools/run-code.js");
    checks.push({ name: "run_code", ok: true, detail: "module loadable" });
  } catch (err) {
    checks.push({
      name: "run_code",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await import("../../schedule/store.js");
    await import("../../goal/store.js");
    checks.push({
      name: "schedule_goals",
      ok: true,
      detail: "schedule + goal stores loadable (--schedule/--goals/--power)",
    });
  } catch (err) {
    checks.push({
      name: "schedule_goals",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  checks.push({
    name: "platform",
    ok: true,
    detail: `${process.platform}/${process.arch}`,
  });

  if (process.platform === "win32") {
    const {
      resolveShellInvocation,
      resetShellInvocationCache,
      windowsShellAvailable,
    } = await import("../../tools/shell-invocation.js");
    resetShellInvocationCache();
    const inv = resolveShellInvocation("win32", "echo ok");
    const available = windowsShellAvailable();
    checks.push({
      name: "windows_shell",
      ok: available,
      detail: available
        ? `${inv.kind} → ${inv.file}`
        : `no pwsh/powershell.exe on PATH (would try ${inv.file})`,
    });
  } else {
    checks.push({
      name: "windows_shell",
      ok: true,
      detail: "skipped (not win32; POSIX uses sh -c)",
    });
  }

  try {
    const { collectStartupReport, formatStartupReport } = await import(
      "./startup-report.js"
    );
    const report = await collectStartupReport({
      ...(parsed.config !== undefined ? { config: parsed.config } : {}),
      ...(parsed.sessionDir !== undefined
        ? { sessionDir: parsed.sessionDir }
        : {}),
    });
    checks.push({
      name: "startup_report",
      ok: true,
      detail: formatStartupReport(report).replace(/\n/g, " | "),
    });
  } catch (err) {
    checks.push({
      name: "startup_report",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

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
