/**
 * R4.18 — pluggable peer discovery sources.
 *
 * Static `--peers` remains the default; mDNS / mesh feed / fake sources
 * plug into the same {@link DiscoverySource} seam and feed a
 * {@link DiscoveryRail} that updates {@link ManagedPeerCluster}.
 */

import type { PeerEndpointConfig } from "./cluster.js";

export type DiscoverySourceKind = "static" | "mdns" | "mesh" | "fake";

export interface DiscoveredPeer {
  id: string;
  /** `"host:port"` endpoint for TCP connect. */
  endpoint: string;
  model?: string;
  capabilities?: ReadonlyArray<string>;
  source: DiscoverySourceKind;
}

export type DiscoveryAnnouncement =
  | { kind: "found"; peer: DiscoveredPeer }
  | { kind: "lost"; peerId: string; source: DiscoverySourceKind };

export type DiscoveryListener = (event: DiscoveryAnnouncement) => void;

/** Pluggable discovery backend. */
export interface DiscoverySource {
  readonly kind: DiscoverySourceKind;
  /** Begin emitting announcements (may replay known peers). */
  start(listener: DiscoveryListener): void | Promise<void>;
  /** Stop emitting; idempotent. */
  stop(): void;
}

function toDiscovered(
  peer: PeerEndpointConfig,
  source: DiscoverySourceKind,
): DiscoveredPeer {
  return {
    id: peer.id,
    endpoint: peer.endpoint,
    source,
    ...(peer.model !== undefined ? { model: peer.model } : {}),
    ...(peer.capabilities !== undefined
      ? { capabilities: peer.capabilities }
      : {}),
  };
}

/** Emit the configured peer list once at start (static `--peers`). */
export class StaticDiscoverySource implements DiscoverySource {
  readonly kind = "static" as const;
  readonly #peers: ReadonlyArray<PeerEndpointConfig>;

  constructor(peers: ReadonlyArray<PeerEndpointConfig>) {
    this.#peers = peers;
  }

  start(listener: DiscoveryListener): void {
    for (const peer of this.#peers) {
      listener({ kind: "found", peer: toDiscovered(peer, "static") });
    }
  }

  stop(): void {
    /* static is fire-and-forget */
  }
}

/**
 * Hermetic / test discovery — publish and revoke peers by hand.
 * Also a stand-in for any push-style feed.
 */
export class FakeDiscoverySource implements DiscoverySource {
  readonly kind = "fake" as const;
  readonly #known = new Map<string, DiscoveredPeer>();
  #listener: DiscoveryListener | undefined;

  start(listener: DiscoveryListener): void {
    this.#listener = listener;
    for (const peer of this.#known.values()) {
      listener({ kind: "found", peer });
    }
  }

  stop(): void {
    this.#listener = undefined;
  }

  /** Announce (or re-announce) a peer. */
  publish(
    peer: Omit<DiscoveredPeer, "source"> & { source?: DiscoverySourceKind },
  ): void {
    const full: DiscoveredPeer = {
      ...peer,
      source: peer.source ?? "fake",
    };
    this.#known.set(full.id, full);
    this.#listener?.({ kind: "found", peer: full });
  }

  /** Withdraw a peer (rail may disconnect). */
  revoke(peerId: string): void {
    this.#known.delete(peerId);
    this.#listener?.({ kind: "lost", peerId, source: "fake" });
  }
}

/**
 * Mesh feed — host pushes peer lists from EnvoyMesh / capability gossip.
 * Start is idle until {@link feed} is called.
 */
export class MeshFeedDiscoverySource implements DiscoverySource {
  readonly kind = "mesh" as const;
  #listener: DiscoveryListener | undefined;
  readonly #known = new Map<string, DiscoveredPeer>();

  start(listener: DiscoveryListener): void {
    this.#listener = listener;
    for (const peer of this.#known.values()) {
      listener({ kind: "found", peer });
    }
  }

  stop(): void {
    this.#listener = undefined;
  }

  /** Replace or upsert peers from a mesh snapshot / delta. */
  feed(peers: ReadonlyArray<Omit<DiscoveredPeer, "source">>): void {
    for (const peer of peers) {
      const full: DiscoveredPeer = { ...peer, source: "mesh" };
      this.#known.set(full.id, full);
      this.#listener?.({ kind: "found", peer: full });
    }
  }

  revoke(peerId: string): void {
    this.#known.delete(peerId);
    this.#listener?.({ kind: "lost", peerId, source: "mesh" });
  }
}

/**
 * mDNS placeholder — real Bonjour/zeroconf wiring lands later.
 * Optional injectable browser keeps the seam testable without OS mDNS.
 */
export class MdnsDiscoverySource implements DiscoverySource {
  readonly kind = "mdns" as const;
  readonly #browser:
    | ((emit: DiscoveryListener) => void | (() => void))
    | undefined;
  #stopBrowser: (() => void) | undefined;

  constructor(options?: {
    /**
     * Injected browser (tests / future real mDNS). Called once on start;
     * may return a stop handle.
     */
    browser?: (emit: DiscoveryListener) => void | (() => void);
  }) {
    this.#browser = options?.browser;
  }

  start(listener: DiscoveryListener): void {
    if (this.#browser === undefined) return;
    const stop = this.#browser(listener);
    if (typeof stop === "function") this.#stopBrowser = stop;
  }

  stop(): void {
    this.#stopBrowser?.();
    this.#stopBrowser = undefined;
  }
}

/** Fan-in several sources into one listener. */
export class CompositeDiscoverySource implements DiscoverySource {
  readonly kind: DiscoverySourceKind;
  readonly #sources: ReadonlyArray<DiscoverySource>;
  readonly #stops: Array<() => void> = [];

  constructor(sources: ReadonlyArray<DiscoverySource>) {
    this.#sources = sources;
    // Prefer first source's kind for labeling; composite is multi-kind.
    this.kind = sources[0]?.kind ?? "static";
  }

  async start(listener: DiscoveryListener): Promise<void> {
    for (const source of this.#sources) {
      await source.start(listener);
      this.#stops.push(() => source.stop());
    }
  }

  stop(): void {
    for (const stop of this.#stops.splice(0)) stop();
  }
}
