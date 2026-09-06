/**
 * Mesh-remote terminal transport (R4.13).
 *
 * Tools follow the execution node: refs use
 * `peer://<peerId>/terminals/<sessionId>`. Package 1 ships the contract
 * + hermetic fake; adapters wire the network path.
 */

import type {
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSessionService,
  TerminalSessionSnapshot,
} from "./types.js";

export interface RemoteTerminalRef {
  peerId: string;
  sessionId: string;
}

export interface RemoteTerminalTransport {
  /** Cumulative / viewport text for a remote terminal. */
  readOutput(ref: string, signal: AbortSignal): Promise<string>;
  /** Line-oriented read (same shape as local service). */
  read(
    ref: string,
    signal: AbortSignal,
    request?: TerminalReadRequest,
  ): Promise<TerminalReadResult>;
  /** Snapshot metadata for one session. */
  getSession(ref: string, signal: AbortSignal): Promise<TerminalSessionSnapshot>;
  /** List sessions on a peer. */
  listSessions(
    peerIdOrRef: string,
    signal: AbortSignal,
  ): Promise<TerminalSessionSnapshot[]>;
  /** Kill / close a remote terminal session. */
  kill(
    ref: string,
    signal: AbortSignal,
    reason?: string,
  ): Promise<boolean>;
}

export class RemoteTerminalError extends Error {
  override readonly name = "RemoteTerminalError";
  constructor(
    message: string,
    readonly code: "NOT_CONFIGURED" | "NOT_FOUND" | "TRANSPORT" | "INVALID_REF",
  ) {
    super(message);
  }
}

const PEER_TERM_REF = /^peer:\/\/([^/]+)\/terminals\/([^/]+)$/;
const PEER_ONLY = /^peer:\/\/([^/]+)\/?$/;

export function formatRemoteTerminalRef(
  peerId: string,
  sessionId: string,
): string {
  return `peer://${peerId}/terminals/${sessionId}`;
}

export function isRemoteTerminalRef(ref: string): boolean {
  return PEER_TERM_REF.test(ref);
}

export function parseRemoteTerminalRef(ref: string): RemoteTerminalRef {
  const m = PEER_TERM_REF.exec(ref);
  if (m === null || m[1] === undefined || m[2] === undefined) {
    throw new RemoteTerminalError(
      `invalid remote terminal ref: ${ref} (expected peer://<peerId>/terminals/<sessionId>)`,
      "INVALID_REF",
    );
  }
  return {
    peerId: decodeURIComponent(m[1]),
    sessionId: decodeURIComponent(m[2]),
  };
}

export function parseRemoteTerminalPeerId(peerIdOrRef: string): string {
  const m = PEER_ONLY.exec(peerIdOrRef);
  if (m?.[1] !== undefined) return decodeURIComponent(m[1]);
  if (peerIdOrRef.includes("://") || peerIdOrRef.includes("/")) {
    throw new RemoteTerminalError(
      `invalid remote peer id: ${peerIdOrRef}`,
      "INVALID_REF",
    );
  }
  return peerIdOrRef;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RemoteTerminalError(
      "remote terminal request aborted",
      "TRANSPORT",
    );
  }
}

export const NOOP_REMOTE_TERMINAL_TRANSPORT: RemoteTerminalTransport = {
  async readOutput(ref: string): Promise<string> {
    throw new RemoteTerminalError(
      `remote terminal ${ref} requires mesh adapter transport`,
      "NOT_CONFIGURED",
    );
  },
  async read(ref: string): Promise<TerminalReadResult> {
    throw new RemoteTerminalError(
      `remote terminal ${ref} requires mesh adapter transport`,
      "NOT_CONFIGURED",
    );
  },
  async getSession(ref: string): Promise<TerminalSessionSnapshot> {
    throw new RemoteTerminalError(
      `remote terminal ${ref} requires mesh adapter transport`,
      "NOT_CONFIGURED",
    );
  },
  async listSessions(peerIdOrRef: string): Promise<TerminalSessionSnapshot[]> {
    throw new RemoteTerminalError(
      `remote terminals on ${peerIdOrRef} require mesh adapter transport`,
      "NOT_CONFIGURED",
    );
  },
  async kill(ref: string): Promise<boolean> {
    throw new RemoteTerminalError(
      `remote terminal ${ref} requires mesh adapter transport`,
      "NOT_CONFIGURED",
    );
  },
};

/**
 * Hermetic fake — attach a local {@link TerminalSessionService} per peer.
 */
export class FakeRemoteTerminalTransport implements RemoteTerminalTransport {
  readonly #peers = new Map<
    string,
    { service: TerminalSessionService; viewer: string }
  >();

  attachPeer(
    peerId: string,
    service: TerminalSessionService,
    options: { viewer: string },
  ): void {
    this.#peers.set(peerId, { service, viewer: options.viewer });
  }

  detachPeer(peerId: string): void {
    this.#peers.delete(peerId);
  }

  #peer(peerId: string): { service: TerminalSessionService; viewer: string } {
    const peer = this.#peers.get(peerId);
    if (peer === undefined) {
      throw new RemoteTerminalError(
        `no remote terminal peer: ${peerId}`,
        "NOT_FOUND",
      );
    }
    return peer;
  }

  async readOutput(ref: string, signal: AbortSignal): Promise<string> {
    const result = await this.read(ref, signal);
    return result.text;
  }

  async read(
    ref: string,
    signal: AbortSignal,
    request?: TerminalReadRequest,
  ): Promise<TerminalReadResult> {
    throwIfAborted(signal);
    const { peerId, sessionId } = parseRemoteTerminalRef(ref);
    const peer = this.#peer(peerId);
    try {
      return peer.service.read(peer.viewer, sessionId, request);
    } catch (err) {
      throw new RemoteTerminalError(
        err instanceof Error ? err.message : String(err),
        "NOT_FOUND",
      );
    }
  }

  async getSession(
    ref: string,
    signal: AbortSignal,
  ): Promise<TerminalSessionSnapshot> {
    throwIfAborted(signal);
    const { peerId, sessionId } = parseRemoteTerminalRef(ref);
    const peer = this.#peer(peerId);
    const hit = peer.service.list(peer.viewer).find((s) => s.sessionId === sessionId);
    if (hit === undefined) {
      throw new RemoteTerminalError(
        `terminal session not found: ${sessionId}`,
        "NOT_FOUND",
      );
    }
    return hit;
  }

  async listSessions(
    peerIdOrRef: string,
    signal: AbortSignal,
  ): Promise<TerminalSessionSnapshot[]> {
    throwIfAborted(signal);
    const peerId = parseRemoteTerminalPeerId(peerIdOrRef);
    const peer = this.#peer(peerId);
    return peer.service.list(peer.viewer);
  }

  async kill(
    ref: string,
    signal: AbortSignal,
    reason?: string,
  ): Promise<boolean> {
    throwIfAborted(signal);
    const { peerId, sessionId } = parseRemoteTerminalRef(ref);
    const peer = this.#peer(peerId);
    try {
      return await peer.service.kill(peer.viewer, sessionId, reason);
    } catch (err) {
      throw new RemoteTerminalError(
        err instanceof Error ? err.message : String(err),
        "NOT_FOUND",
      );
    }
  }
}
