/**
 * R4.14b — exec-world: where FS/shell tools actually run.
 *
 * Coordinator may keep the model loop local while tools target a
 * worker peer (Codex exec-server idea). Package 1 defines the seam +
 * hermetic fake; peer/MAP adapters inject {@link RemoteExecTransport}.
 */

export type ExecWorldTarget =
  | { kind: "local" }
  | { kind: "peer"; peerId: string };

export interface ExecReadResult {
  content: string;
  truncated: boolean;
  byteLength: number;
}

export interface ExecShellRequest {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Where read/write/shell run for the coordinator's tools. */
export interface ExecWorld {
  readonly target: ExecWorldTarget;
  readFile(
    filePath: string,
    options: { maxBytes?: number },
    signal: AbortSignal,
  ): Promise<ExecReadResult>;
  writeFile(
    filePath: string,
    content: string,
    options: { createDirectories?: boolean },
    signal: AbortSignal,
  ): Promise<void>;
  runShell(
    request: ExecShellRequest,
    signal: AbortSignal,
  ): Promise<ExecShellResult>;
}

/**
 * Network-facing exec transport (peer MAP / adapter).
 * Refs are bare paths on the worker; peer id is separate.
 */
export interface RemoteExecTransport {
  readFile(
    peerId: string,
    filePath: string,
    options: { maxBytes?: number },
    signal: AbortSignal,
  ): Promise<ExecReadResult>;
  writeFile(
    peerId: string,
    filePath: string,
    content: string,
    options: { createDirectories?: boolean },
    signal: AbortSignal,
  ): Promise<void>;
  runShell(
    peerId: string,
    request: ExecShellRequest,
    signal: AbortSignal,
  ): Promise<ExecShellResult>;
}

export class ExecWorldError extends Error {
  override readonly name = "ExecWorldError";
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "TRANSPORT" | "DENIED" | "IO",
  ) {
    super(message);
  }
}
