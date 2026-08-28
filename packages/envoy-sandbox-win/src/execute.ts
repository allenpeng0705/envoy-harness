/**
 * F2b — execute a command under a sandbox policy profile.
 *
 * **Scaffold:** validates cwd against writable roots, runs via
 * `cmd.exe /c` on Windows (job-object lifecycle). Full Codex-class
 * FS ACL isolation (`windows-sandbox-rs`) swaps in behind this API.
 */

import type { SandboxPolicy } from "@envoymesh/envoy-harness";

import type { SidecarExecuteResult } from "./protocol.js";

const DEFAULT_MAX_OUTPUT = 1024 * 1024;

export interface ExecuteOptions {
  command: string;
  cwd: string;
  policy: SandboxPolicy;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export async function executeSandboxed(
  options: ExecuteOptions,
): Promise<SidecarExecuteResult> {
  const cwd = options.cwd;
  if (!isPathAllowed(cwd, options.policy, cwd)) {
    return {
      stdout: "",
      stderr: `sandbox: cwd not allowed under policy: ${cwd}`,
      exitCode: 125,
      isError: true,
      stdoutTruncated: false,
      stderrTruncated: false,
      fsIsolation: false,
    };
  }

  const cap = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  if (process.platform === "win32") {
    return executeWin32(options.command, cwd, cap, options.signal);
  }
  return executeSh(options.command, cwd, cap, options.signal);
}

function isPathAllowed(
  path: string,
  policy: SandboxPolicy,
  sessionCwd: string,
): boolean {
  if (policy.mode === "danger-full-access") return true;
  if (policy.mode === "read-only") {
    return path === sessionCwd || path.startsWith(sessionCwd + "/");
  }
  const roots = [...policy.writableRoots, sessionCwd];
  return roots.some(
    (root) => path === root || path.startsWith(root.replace(/\\/g, "/") + "/"),
  );
}

async function executeWin32(
  command: string,
  cwd: string,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<SidecarExecuteResult> {
  const { spawn } = await import("node:child_process");
  return captureSpawn(
    spawn("cmd.exe", ["/d", "/s", "/c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal !== undefined ? { signal } : {}),
    }),
    maxOutputBytes,
    { fsIsolation: false },
  );
}

async function executeSh(
  command: string,
  cwd: string,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<SidecarExecuteResult> {
  const { spawn } = await import("node:child_process");
  return captureSpawn(
    spawn("sh", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal !== undefined ? { signal } : {}),
    }),
    maxOutputBytes,
    { fsIsolation: false },
  );
}

function captureSpawn(
  child: import("node:child_process").ChildProcess,
  cap: number,
  meta: { fsIsolation: boolean },
): Promise<SidecarExecuteResult> {
  return new Promise((resolve) => {
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outTotal = 0;
    let errTotal = 0;
    let outTruncated = false;
    let errTruncated = false;

    const onOut = (chunk: Buffer): void => {
      if (outTotal >= cap) {
        outTruncated = true;
        return;
      }
      const take = Math.min(chunk.length, cap - outTotal);
      outChunks.push(chunk.subarray(0, take));
      outTotal += take;
      if (take < chunk.length) outTruncated = true;
    };
    const onErr = (chunk: Buffer): void => {
      if (errTotal >= cap) {
        errTruncated = true;
        return;
      }
      const take = Math.min(chunk.length, cap - errTotal);
      errChunks.push(chunk.subarray(0, take));
      errTotal += take;
      if (take < chunk.length) errTruncated = true;
    };

    child.stdout?.on("data", onOut);
    child.stderr?.on("data", onErr);
    child.on("error", (err) => {
      resolve({
        stdout: "",
        stderr: err.message,
        exitCode: 1,
        isError: true,
        stdoutTruncated: false,
        stderrTruncated: false,
        fsIsolation: meta.fsIsolation,
      });
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(outChunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      const exitCode = code ?? 1;
      resolve({
        stdout,
        stderr,
        exitCode,
        isError: exitCode !== 0,
        stdoutTruncated: outTruncated,
        stderrTruncated: errTruncated,
        fsIsolation: meta.fsIsolation,
      });
    });
  });
}
