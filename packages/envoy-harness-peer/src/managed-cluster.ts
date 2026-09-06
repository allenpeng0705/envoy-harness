/**
 * Mutable peer cluster — connect peers at startup or at runtime (`cluster/connect`).
 */

import type { ProtocolClusterStatus } from "@envoymesh/envoy-harness";

import type { PeerEndpointConfig } from "./cluster.js";
import { createPeerUiBackend, type PeerUiBackend } from "./cli/ui.js";
import type { PeerEventSink } from "./events.js";
import type { PeerSigner } from "./envelope.js";
import { PeerRegistry } from "./registry.js";
import {
  clusterStatusFromConnect,
  type ConnectResultLike,
  type PeerHealthInfo,
} from "./status.js";
import { connectPeerClient } from "./tcp.js";
import { TeamJobRegistry } from "./team-jobs.js";

export interface ManagedPeerClusterOptions {
  connectTimeoutMs?: number;
  signer?: PeerSigner;
  onEvent?: PeerEventSink;
  onFailure?: (id: string, err: Error) => void;
  connect?: typeof connectPeerClient;
  /** R4.7 — shared team/jobs board (defaults to a new registry). */
  teamJobRegistry?: TeamJobRegistry;
}

export interface ConnectPeerResult {
  ok: boolean;
  error?: string;
}

/** Live peer pool with runtime `connectPeer` support. */
export class ManagedPeerCluster implements ConnectResultLike {
  readonly registry = new PeerRegistry();
  readonly connected: string[] = [];
  readonly failed: Array<{ id: string; error: string }> = [];
  readonly teamJobRegistry: TeamJobRegistry;
  readonly #closers = new Map<string, () => void>();
  readonly #options: ManagedPeerClusterOptions;

  constructor(options: ManagedPeerClusterOptions = {}) {
    this.#options = options;
    this.teamJobRegistry = options.teamJobRegistry ?? new TeamJobRegistry();
  }

  /** Connect every configured peer (fail-open per peer). */
  async connectPeers(peers: ReadonlyArray<PeerEndpointConfig>): Promise<void> {
    for (const peer of peers) {
      await this.connectPeer(peer);
    }
  }

  /** Connect one peer endpoint and register it in the pool. */
  async connectPeer(peer: PeerEndpointConfig): Promise<ConnectPeerResult> {
    if (this.registry.get(peer.id) !== undefined) {
      return { ok: false, error: `peer already connected: ${peer.id}` };
    }

    const failedIndex = this.failed.findIndex((f) => f.id === peer.id);
    if (failedIndex !== -1) {
      this.failed.splice(failedIndex, 1);
    }

    const colon = peer.endpoint.lastIndexOf(":");
    const host = colon === -1 ? "" : peer.endpoint.slice(0, colon);
    const port = Number(peer.endpoint.slice(colon + 1));
    if (host === "" || !Number.isInteger(port) || port <= 0) {
      const error = `bad endpoint "${peer.endpoint}"`;
      this.#recordFailure(peer.id, error);
      return { ok: false, error };
    }

    const connect = this.#options.connect ?? connectPeerClient;
    try {
      const { client, close } = await connect({
        host,
        port,
        ...(this.#options.connectTimeoutMs !== undefined
          ? { connectTimeoutMs: this.#options.connectTimeoutMs }
          : {}),
        ...(this.#options.signer !== undefined ? { signer: this.#options.signer } : {}),
        ...(this.#options.onEvent !== undefined ? { onEvent: this.#options.onEvent } : {}),
      });
      const unregister = this.registry.register({
        id: peer.id,
        client,
        ...(peer.model !== undefined ? { model: peer.model } : {}),
        ...(peer.capabilities !== undefined
          ? { capabilities: peer.capabilities }
          : {}),
      });
      this.#closers.set(peer.id, () => {
        close();
        unregister();
      });
      this.connected.push(peer.id);
      this.#options.onEvent?.({
        type: "peer.connected",
        peerId: peer.id,
        at: Date.now(),
      });
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const wrapped = err instanceof Error ? err : new Error(error);
      this.#recordFailure(peer.id, error, wrapped);
      return { ok: false, error };
    }
  }

  #recordFailure(id: string, error: string, err?: Error): void {
    const existing = this.failed.findIndex((f) => f.id === id);
    if (existing === -1) {
      this.failed.push({ id, error });
    } else {
      this.failed[existing] = { id, error };
    }
    this.#options.onEvent?.({
      type: "peer.failed",
      peerId: id,
      error,
      at: Date.now(),
    });
    if (err !== undefined) {
      this.#options.onFailure?.(id, err);
    }
  }

  /** Build the cluster-console ACP backend over this live pool. */
  createUiBackend(
    healthProvider?: () => Promise<ReadonlyMap<string, PeerHealthInfo>>,
  ): PeerUiBackend {
    return createPeerUiBackend({
      registry: this.registry,
      connected: this.connected,
      failed: this.failed,
      teamJobRegistry: this.teamJobRegistry,
      ...(healthProvider !== undefined ? { healthProvider } : {}),
      ...(this.#options.onEvent !== undefined
        ? { onEvent: this.#options.onEvent }
        : {}),
    });
  }

  clusterStatus(
    health?: ReadonlyMap<string, PeerHealthInfo>,
  ): ProtocolClusterStatus {
    return clusterStatusFromConnect(this, health);
  }

  /** Disconnect one peer by id (no-op if unknown). */
  disconnectPeer(id: string): boolean {
    const close = this.#closers.get(id);
    if (close === undefined) return false;
    close();
    this.#closers.delete(id);
    const idx = this.connected.indexOf(id);
    if (idx !== -1) this.connected.splice(idx, 1);
    this.#options.onEvent?.({
      type: "peer.disconnected",
      peerId: id,
      at: Date.now(),
    });
    return true;
  }

  closeAll(): void {
    for (const id of [...this.connected]) {
      this.disconnectPeer(id);
    }
  }
}
