/**
 * R4.18 — wire {@link DiscoverySource} announcements into a
 * {@link ManagedPeerCluster} (connect on found, optional disconnect on lost).
 */

import type { PeerEndpointConfig } from "./cluster.js";
import type {
  DiscoveryAnnouncement,
  DiscoverySource,
  DiscoveredPeer,
} from "./discovery.js";
import type { ManagedPeerCluster } from "./managed-cluster.js";

export interface DiscoveryRailOptions {
  cluster: ManagedPeerCluster;
  sources: ReadonlyArray<DiscoverySource>;
  /**
   * When true (default), `lost` disconnects the peer if still registered.
   * Static sources never emit lost.
   */
  disconnectOnLost?: boolean;
  /** Optional hook after each announcement is handled. */
  onAnnouncement?: (event: DiscoveryAnnouncement) => void;
}

export interface DiscoveryRail {
  /** Start all sources (idempotent if already running). */
  start(): Promise<void>;
  /** Stop all sources. */
  stop(): void;
  /** Whether {@link start} has been called and not stopped. */
  readonly running: boolean;
}

function toEndpoint(peer: DiscoveredPeer): PeerEndpointConfig {
  return {
    id: peer.id,
    endpoint: peer.endpoint,
    ...(peer.model !== undefined ? { model: peer.model } : {}),
    ...(peer.capabilities !== undefined
      ? { capabilities: [...peer.capabilities] }
      : {}),
  };
}

/**
 * Attach discovery sources to a managed cluster. Found peers are
 * connected via `cluster.connectPeer` (fail-open / already-connected safe).
 */
export function createDiscoveryRail(
  options: DiscoveryRailOptions,
): DiscoveryRail {
  const disconnectOnLost = options.disconnectOnLost !== false;
  let running = false;
  const started: DiscoverySource[] = [];

  const handle = async (event: DiscoveryAnnouncement): Promise<void> => {
    options.onAnnouncement?.(event);
    if (event.kind === "found") {
      await options.cluster.connectPeer(toEndpoint(event.peer));
      return;
    }
    if (disconnectOnLost) {
      options.cluster.disconnectPeer(event.peerId);
    }
  };

  // Serial queue so concurrent publishes don't race registry.register.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (event: DiscoveryAnnouncement): void => {
    chain = chain.then(() => handle(event)).catch(() => {
      /* connectPeer already fail-open; swallow rail errors */
    });
  };

  return {
    get running() {
      return running;
    },
    async start() {
      if (running) return;
      running = true;
      for (const source of options.sources) {
        await source.start(enqueue);
        started.push(source);
      }
      await chain;
    },
    stop() {
      if (!running) return;
      running = false;
      for (const source of started.splice(0)) source.stop();
    },
  };
}
