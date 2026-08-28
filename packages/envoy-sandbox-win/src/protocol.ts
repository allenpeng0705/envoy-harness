/**
 * F2b — newline-delimited JSON IPC between harness and sidecar.
 */

import type { SandboxPolicy } from "@envoymesh/envoy-harness";

export interface SidecarExecuteParams {
  command: string;
  cwd: string;
  policy: SandboxPolicy;
  maxOutputBytes?: number;
}

export interface SidecarExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  isError: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** F2b scaffold: true when native FS ACL isolation is active. */
  fsIsolation?: boolean;
}

export interface SidecarRequest {
  id: string;
  method: "execute" | "ping";
  params?: SidecarExecuteParams;
}

export interface SidecarResponse {
  id: string;
  ok: boolean;
  result?: SidecarExecuteResult | { pong: true; platform: string };
  error?: string;
}
