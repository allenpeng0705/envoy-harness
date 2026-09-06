/**
 * Hermetic remote exec transport + peer-targeted {@link ExecWorld}.
 */

import type {
  ExecReadResult,
  ExecShellRequest,
  ExecShellResult,
  ExecWorld,
  RemoteExecTransport,
} from "./types.js";
import { ExecWorldError } from "./types.js";

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ExecWorldError("remote exec aborted", "TRANSPORT");
  }
}

/**
 * In-memory FS + optional shell script — hermetic stand-in for a
 * worker peer's exec surface (no network).
 */
export class FakeRemoteExecTransport implements RemoteExecTransport {
  readonly #files = new Map<string, string>();
  readonly #shell: (
    peerId: string,
    request: ExecShellRequest,
  ) => ExecShellResult | Promise<ExecShellResult>;

  constructor(options?: {
    files?: Record<string, string>;
    shell?: (
      peerId: string,
      request: ExecShellRequest,
    ) => ExecShellResult | Promise<ExecShellResult>;
  }) {
    if (options?.files !== undefined) {
      for (const [k, v] of Object.entries(options.files)) {
        this.#files.set(k, v);
      }
    }
    this.#shell =
      options?.shell ??
      ((_peerId, request) => ({
        stdout: `fake-shell:${request.command}`,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }));
  }

  /** Test helper — inspect virtual FS. */
  getFile(path: string): string | undefined {
    return this.#files.get(path);
  }

  async readFile(
    _peerId: string,
    filePath: string,
    options: { maxBytes?: number },
    signal: AbortSignal,
  ): Promise<ExecReadResult> {
    throwIfAborted(signal);
    const raw = this.#files.get(filePath);
    if (raw === undefined) {
      throw new ExecWorldError(`ENOENT: ${filePath}`, "NOT_FOUND");
    }
    const buf = Buffer.from(raw, "utf8");
    const cap = options.maxBytes ?? 1024 * 1024;
    const truncated = buf.byteLength > cap;
    const slice = truncated ? buf.subarray(0, cap) : buf;
    return {
      content: slice.toString("utf8"),
      truncated,
      byteLength: buf.byteLength,
    };
  }

  async writeFile(
    _peerId: string,
    filePath: string,
    content: string,
    _options: { createDirectories?: boolean },
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    this.#files.set(filePath, content);
  }

  async runShell(
    peerId: string,
    request: ExecShellRequest,
    signal: AbortSignal,
  ): Promise<ExecShellResult> {
    throwIfAborted(signal);
    return this.#shell(peerId, request);
  }
}

/** Coordinator tools target a worker peer via {@link RemoteExecTransport}. */
export function createPeerExecWorld(options: {
  peerId: string;
  transport: RemoteExecTransport;
}): ExecWorld {
  const { peerId, transport } = options;
  return {
    target: { kind: "peer", peerId },
    readFile: (filePath, opts, signal) =>
      transport.readFile(peerId, filePath, opts, signal),
    writeFile: (filePath, content, opts, signal) =>
      transport.writeFile(peerId, filePath, content, opts, signal),
    runShell: (request, signal) =>
      transport.runShell(peerId, request, signal),
  };
}
