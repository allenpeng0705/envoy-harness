/**
 * R4.18 — pluggable peer discovery sources.
 *
 * Static `--peers` remains the default; mDNS / mesh feed / fake sources
 * plug into the same {@link DiscoverySource} seam and feed a
 * {@link DiscoveryRail} that updates {@link ManagedPeerCluster}.
 */

import type { PeerEndpointConfig } from "./cluster.js";
import {
  MdnsBrowser,
  type MdnsScheduler,
  type MdnsSocketFactory,
} from "./mdns/index.js";

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
 * Real mDNS / DNS-SD discovery (RFC 6762/6763).
 *
 * Earlier revisions shipped a *placeholder* here: it only emitted
 * announcements when the host injected a `browser`, so
 * `envoy-harness --discovery mdns` silently discovered nothing — a
 * documented-but-unimplemented flag. It now drives a real
 * {@link MdnsBrowser} by default.
 *
 * The injected `browser` seam is retained for hosts and tests:
 * - inject a browser → it is used verbatim (hermetic tests);
 * - pass `socketFactory` → a real browser with a fake socket;
 * - pass `disabled: true` → an inert source (explicit opt-out);
 * - pass nothing → a real browser on the LAN.
 *
 * One announcement may cover several peers, and a refresh (the same
 * peer re-announced with a new TTL) must NOT re-announce `found` to the
 * rail on every sweep — the rail would re-connect and log noise. So the
 * source de-duplicates by `(peerId, endpoint, model)`.
 */
export class MdnsDiscoverySource implements DiscoverySource {
  readonly kind = "mdns" as const;
  readonly #browser:
    | ((emit: DiscoveryListener) => void | (() => void))
    | undefined;
  readonly #options: MdnsDiscoverySourceOptions;
  #stopBrowser: (() => void) | undefined;
  #mdns: MdnsBrowser | undefined;
  /** Announcement signature per peer, to suppress TTL-refresh churn. */
  readonly #announced = new Map<string, string>();

  constructor(options: MdnsDiscoverySourceOptions = {}) {
    this.#browser = options.browser;
    this.#options = options;
  }

  start(listener: DiscoveryListener): void | Promise<void> {
    if (this.#options.disabled === true) return;
    if (this.#browser !== undefined) {
      const stop = this.#browser(listener);
      if (typeof stop === "function") this.#stopBrowser = stop;
      return;
    }

    const browser = new MdnsBrowser({
      ...(this.#options.socketFactory !== undefined
        ? { socketFactory: this.#options.socketFactory }
        : {}),
      ...(this.#options.scheduler !== undefined
        ? { scheduler: this.#options.scheduler }
        : {}),
      ...(this.#options.queryIntervalMs !== undefined
        ? { queryIntervalMs: this.#options.queryIntervalMs }
        : {}),
      ...(this.#options.sweepIntervalMs !== undefined
        ? { sweepIntervalMs: this.#options.sweepIntervalMs }
        : {}),
      ...(this.#options.defaultTtlSeconds !== undefined
        ? { defaultTtlSeconds: this.#options.defaultTtlSeconds }
        : {}),
      // Discovery is optional: a machine with multicast blocked must
      // still run. Report and carry on with the other sources.
      onError: (err) => this.#options.onError?.(err),
    });
    this.#mdns = browser;

    return browser.start((event) => {
      const record = event.record;
      const endpoint = `${record.host}:${record.port}`;
      if (event.kind === "lost") {
        this.#announced.delete(record.peerId);
        listener({ kind: "lost", peerId: record.peerId, source: "mdns" });
        return;
      }
      const signature = `${endpoint}|${record.model ?? ""}|${(record.capabilities ?? []).join(",")}`;
      if (this.#announced.get(record.peerId) === signature) return;
      this.#announced.set(record.peerId, signature);
      listener({
        kind: "found",
        peer: {
          id: record.peerId,
          endpoint,
          source: "mdns",
          ...(record.model !== undefined ? { model: record.model } : {}),
          ...(record.capabilities !== undefined
            ? { capabilities: [...record.capabilities] }
            : {}),
        },
      });
    });
  }

  stop(): void {
    this.#stopBrowser?.();
    this.#stopBrowser = undefined;
    this.#mdns?.stop();
    this.#mdns = undefined;
    this.#announced.clear();
  }
}

/** Options for {@link MdnsDiscoverySource}. */
export interface MdnsDiscoverySourceOptions {
  /** Legacy/hermetic injection: a function that emits announcements. */
  browser?: (emit: DiscoveryListener) => void | (() => void);
  /** Inject a fake UDP socket (tests) while keeping the real logic. */
  socketFactory?: MdnsSocketFactory;
  /** Inject clock/timers (tests). */
  scheduler?: MdnsScheduler;
  /** Re-query interval. */
  queryIntervalMs?: number;
  /** TTL sweep interval. */
  sweepIntervalMs?: number;
  /** TTL when a responder omits one. */
  defaultTtlSeconds?: number;
  /** Report multicast/bind failures without failing the host. */
  onError?: (err: Error) => void;
  /** Explicitly inert (used when `--discovery none`). */
  disabled?: boolean;
}

/** Fan-in several sources into one listener. */
export class CompositeDiscoverySource implements DiscoverySource {
  readonly kind: DiscoverySourceKind;
  /** Child sources (rail flattens these for lost/found refcounting). */
  readonly sources: ReadonlyArray<DiscoverySource>;
  readonly #stops: Array<() => void> = [];

  constructor(sources: ReadonlyArray<DiscoverySource>) {
    this.sources = sources;
    // Prefer first source's kind for labeling; composite is multi-kind.
    this.kind = sources[0]?.kind ?? "static";
  }

  async start(listener: DiscoveryListener): Promise<void> {
    for (const source of this.sources) {
      await source.start(listener);
      this.#stops.push(() => source.stop());
    }
  }

  stop(): void {
    for (const stop of this.#stops.splice(0)) stop();
  }
}
