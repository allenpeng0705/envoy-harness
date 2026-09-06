/**
 * R4.18 — wire {@link DiscoverySource} announcements into a
 * {@link ManagedPeerCluster} (connect on found, optional disconnect on lost).
 */

import type { PeerEndpointConfig } from "./cluster.js";
import {
  CompositeDiscoverySource,
  type DiscoveryAnnouncement,
  type DiscoverySource,
  type DiscoveredPeer,
} from "./discovery.js";
import type { ManagedPeerCluster } from "./managed-cluster.js";

export interface DiscoveryRailOptions {
  cluster: ManagedPeerCluster;
  sources: ReadonlyArray<DiscoverySource>;
  /**
   * When true (default), `lost` disconnects the peer if still registered.
   * Static sources never emit lost.
   * Disconnect only runs when **no** attached source still advertises
   * the peer (composite refcount).
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

/** Flatten composites so lost/found refcounting is per leaf source. */
function flattenSources(
  sources: ReadonlyArray<DiscoverySource>,
): DiscoverySource[] {
  const out: DiscoverySource[] = [];
  for (const source of sources) {
    if (source instanceof CompositeDiscoverySource) {
      out.push(...flattenSources(source.sources));
    } else {
      out.push(source);
    }
  }
  return out;
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
  /** peerId → sources currently advertising it (object identity). */
  const advertisers = new Map<string, Set<DiscoverySource>>();
  const leafSources = flattenSources(options.sources);

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

  const listenFor = (
    source: DiscoverySource,
  ): ((event: DiscoveryAnnouncement) => void) => {
    return (event) => {
      if (event.kind === "found") {
        let set = advertisers.get(event.peer.id);
        if (set === undefined) {
          set = new Set();
          advertisers.set(event.peer.id, set);
        }
        set.add(source);
        enqueue(event);
        return;
      }
      const set = advertisers.get(event.peerId);
      set?.delete(source);
      if (set === undefined || set.size === 0) {
        advertisers.delete(event.peerId);
        enqueue(event);
      }
      // else: another source still advertises — keep the connection
    };
  };

  return {
    get running() {
      return running;
    },
    async start() {
      if (running) return;
      try {
        for (const source of leafSources) {
          await source.start(listenFor(source));
          started.push(source);
        }
        running = true;
        await chain;
      } catch (err) {
        for (const source of started.splice(0)) source.stop();
        advertisers.clear();
        running = false;
        throw err;
      }
    },
    stop() {
      if (!running && started.length === 0) return;
      running = false;
      for (const source of started.splice(0)) source.stop();
      advertisers.clear();
    },
  };
}
