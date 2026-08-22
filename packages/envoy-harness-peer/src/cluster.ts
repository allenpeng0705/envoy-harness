/**
 * R2 — the peer cluster: static discovery (`connectPeerClients`) + a
 * dynamic `MeshSubmitter` over the cluster (`createPeerClusterSubmitter`).
 */

import type {
  MeshSubmitter,
  SubagentInput,
  SubagentResult,
} from "@envoymesh/envoy-harness";

import { connectPeerClient, type TcpPeerClient } from "./tcp.js";
import type { PeerEventSink } from "./events.js";
import type { PeerSigner } from "./envelope.js";
import { PeerMeshSubmitter } from "./submitter.js";
import { PeerRegistry } from "./registry.js";

export interface PeerEndpointConfig {
  /** Stable peer id. */
  id: string;
  /** `"host:port"` — the peer server endpoint. */
  endpoint: string;
  /** The peer's model (routing). */
  model?: string;
  /** Capability tags the peer can run. */
  capabilities?: string[];
}

export interface ConnectPeerClientsResult {
  registry: PeerRegistry;
  /** Connected peer ids. */
  connected: string[];
  /**
   * Peers that failed to connect (fail-open — the rest still work).
   * Failed peers have NO closer: they never connected, so `closeAll()`
   * only closes the successful sockets. Entries are in config order.
   */
  failed: Array<{ id: string; error: string }>;
  /** Close every connected socket. */
  closeAll(): void;
}

/** Static discovery: connect every configured peer endpoint (fail-open). */
export async function connectPeerClients(
  config: ReadonlyArray<PeerEndpointConfig>,
  options?: {
    connectTimeoutMs?: number;
    signer?: PeerSigner;
    onEvent?: PeerEventSink;
    /**
     * Injectable connect for tests / custom transports. Defaults to the
     * production TCP connect.
     */
    connect?: typeof connectPeerClient;
    /** Called for each failed connect (e.g. host logging). */
    onFailure?: (id: string, err: Error) => void;
  },
): Promise<ConnectPeerClientsResult> {
  const registry = new PeerRegistry();
  const closers: Array<() => void> = [];
  const connected: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  const connect = options?.connect ?? connectPeerClient;

  type Attempt =
    | {
        ok: true;
        peer: PeerEndpointConfig;
        client: TcpPeerClient["client"];
        close(): void;
      }
    | { ok: false; peer: PeerEndpointConfig; error: string; err: Error };

  // R3 — connect every endpoint concurrently: a dead peer's connect
  // timeout must not delay the healthy peers. Fail-open is preserved:
  // each attempt catches its own error, and the successful peers still
  // form the cluster (in config order, so the result is deterministic).
  const attempts = await Promise.all(
    config.map(async (peer): Promise<Attempt> => {
      const colon = peer.endpoint.lastIndexOf(":");
      const host = colon === -1 ? "" : peer.endpoint.slice(0, colon);
      const port = Number(peer.endpoint.slice(colon + 1));
      if (host === "" || !Number.isInteger(port) || port <= 0) {
        options?.onEvent?.({
          type: "peer.failed",
          peerId: peer.id,
          error: `bad endpoint "${peer.endpoint}"`,
          at: Date.now(),
        });
        return {
          ok: false,
          peer,
          error: `bad endpoint "${peer.endpoint}"`,
          err: new Error(`bad endpoint "${peer.endpoint}"`),
        };
      }
      try {
        const { client, close } = await connect({
          host,
          port,
          ...(options?.connectTimeoutMs !== undefined
            ? { connectTimeoutMs: options.connectTimeoutMs }
            : {}),
          ...(options?.signer !== undefined ? { signer: options.signer } : {}),
          ...(options?.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
        });
        options?.onEvent?.({
          type: "peer.connected",
          peerId: peer.id,
          at: Date.now(),
        });
        return { ok: true, peer, client, close };
      } catch (err) {
        options?.onEvent?.({
          type: "peer.failed",
          peerId: peer.id,
          error: err instanceof Error ? err.message : String(err),
          at: Date.now(),
        });
        return {
          ok: false,
          peer,
          error: err instanceof Error ? err.message : String(err),
          err: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }),
  );

  for (const attempt of attempts) {
    if (attempt.ok) {
      const peer = attempt.peer;
      registry.register({
        id: peer.id,
        client: attempt.client,
        ...(peer.model !== undefined ? { model: peer.model } : {}),
        ...(peer.capabilities !== undefined
          ? { capabilities: peer.capabilities }
          : {}),
      });
      closers.push(attempt.close);
      connected.push(peer.id);
      continue;
    }
    failed.push({ id: attempt.peer.id, error: attempt.error });
    options?.onFailure?.(attempt.peer.id, attempt.err);
  }

  return {
    registry,
    connected,
    failed,
    closeAll: () => {
      for (const c of closers) c();
      for (const id of connected) {
        options?.onEvent?.({
          type: "peer.disconnected",
          peerId: id,
          at: Date.now(),
        });
      }
      closers.length = 0;
    },
  };
}

export interface PeerClusterSubmitterOptions {
  /** Default cost ceiling (USD). Default 1. */
  defaultCostCeilingUsd?: number;
  /** Default deadline (ms). Default 60s. */
  defaultDeadlineMs?: number;
}

/**
 * A dynamic `MeshSubmitter` over the cluster: routes each submit by
 * `preferredPeerId`, then model/capability via the registry, then any
 * peer. The execution pool for a mesh node's worker (Pattern A).
 */
export function createPeerClusterSubmitter(
  registry: PeerRegistry,
  options: PeerClusterSubmitterOptions = {},
): MeshSubmitter {
  return {
    async submit(input: SubagentInput, signal: AbortSignal): Promise<SubagentResult> {
      const entry =
        (input.preferredPeerId !== undefined
          ? registry.get(input.preferredPeerId)
          : undefined) ??
        registry.route(input) ??
        registry.list()[0];
      if (entry === undefined) {
        throw new Error("peer cluster: no peer available");
      }
      const submitter = new PeerMeshSubmitter({
        client: entry.client,
        workerPeerId: entry.id,
      });
      return submitter.submit(
        {
          ...input,
          costCeilingUsd:
            input.costCeilingUsd ?? options.defaultCostCeilingUsd ?? 1,
          deadlineMs: input.deadlineMs ?? options.defaultDeadlineMs ?? 60_000,
        },
        signal,
      );
    },
  };
}
