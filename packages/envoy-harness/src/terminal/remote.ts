/**
 * Mesh-remote terminal transport seam (Package 1 stub).
 */

export interface RemoteTerminalTransport {
  /** Read output from a terminal hosted on a peer. */
  readOutput(ref: string, signal: AbortSignal): Promise<string>;
}

export class RemoteTerminalError extends Error {
  override readonly name = "RemoteTerminalError";
  constructor(
    message: string,
    readonly code: "NOT_CONFIGURED" | "NOT_FOUND" | "TRANSPORT",
  ) {
    super(message);
  }
}

export const NOOP_REMOTE_TERMINAL_TRANSPORT: RemoteTerminalTransport = {
  async readOutput(ref: string): Promise<string> {
    throw new RemoteTerminalError(
      `remote terminal ${ref} requires mesh adapter transport`,
      "NOT_CONFIGURED",
    );
  },
};
