/**
 * Optional peer-cluster wiring for ACP/SDK hosts.
 *
 * **Why the peer package is named, not imported by a literal specifier.**
 * Both a type query (`typeof import(...)`) and a literal dynamic import are
 * resolved by `tsc`, so core needed the peer package's declarations to
 * build — while the peer package depends on core. Nothing could build from
 * a clean checkout. The surface core uses is declared locally as
 * {@link PeerCompatModule}, and the module is loaded through a `string`
 * variable so the build stays independent. Runtime behaviour is unchanged:
 * still optional, still loaded on demand.
 */

import type { ProtocolSessionBackend } from "../protocol/session-backend.js";
import type { ResolvedPeerEndpoint } from "./resolve.js";

export type ClusterSeams = Pick<
  ProtocolSessionBackend,
  | "listPeers"
  | "clusterStatus"
  | "routePeer"
  | "scoreboardSummary"
  | "teamJobs"
  | "subscribeDiscovery"
  | "connectPeer"
>;

/** A configured peer, as the discovery sources consume it. */
interface PeerEndpointConfig {
  id: string;
  endpoint: string;
  model?: string;
  capabilities?: ReadonlyArray<string>;
}

/** The managed cluster the harness drives. */
interface ManagedPeerClusterLike {
  connectPeer(params: {
    id: string;
    endpoint: string;
    model?: string;
    capabilities?: ReadonlyArray<string>;
  }): Promise<unknown>;
  createUiBackend(): {
    backend: ClusterSeams;
    close(): void;
  };
  closeAll(): void;
}

/** The subset of `@envoymesh/envoy-harness-peer` the harness calls. */
interface PeerCompatModule {
  ManagedPeerCluster: new (options: {
    connectTimeoutMs?: number;
    onFailure?: (id: string, err: Error) => void;
  }) => ManagedPeerClusterLike;
  StaticDiscoverySource: new (
    peers: ReadonlyArray<PeerEndpointConfig>,
  ) => unknown;
  MdnsDiscoverySource: new (options: {
    onError: (err: Error) => void;
  }) => unknown;
  createDiscoveryRail(options: {
    cluster: ManagedPeerClusterLike;
    sources: ReadonlyArray<unknown>;
  }): { start(): Promise<void>; stop(): void };
}

const PEER_PACKAGE: string = "@envoymesh/envoy-harness-peer";

/** R5.3 — how configured `--peers` enter the managed cluster. */
export type PeerDiscoveryMode = "static" | "mdns" | "none";

export interface WirePeerClusterOptions {
  peers: ReadonlyArray<ResolvedPeerEndpoint>;
  connectTimeoutMs?: number;
  /** When true, wire an empty pool that still supports `cluster/connect`. */
  enableRuntimeConnect?: boolean;
  /**
   * R5.3 — discovery mode (default `static`).
   * - `static`: `--peers` via discovery rail (StaticDiscoverySource)
   * - `mdns`: static peers + mDNS source placeholder (inject browser later)
   * - `none`: do not auto-connect `--peers`; runtime `connectPeer` only
   */
  discovery?: PeerDiscoveryMode;
  onFailure?: (id: string, err: Error) => void;
}

export interface WirePeerClusterResult {
  seams: ClusterSeams;
  dispose: () => Promise<void>;
}

/** Merge cluster protocol methods onto a base session backend. */
export function mergeClusterSeams(
  base: ProtocolSessionBackend,
  seams: ClusterSeams,
): ProtocolSessionBackend {
  return {
    ...base,
    ...(seams.listPeers !== undefined ? { listPeers: seams.listPeers } : {}),
    ...(seams.clusterStatus !== undefined
      ? { clusterStatus: seams.clusterStatus }
      : {}),
    ...(seams.routePeer !== undefined ? { routePeer: seams.routePeer } : {}),
    ...(seams.scoreboardSummary !== undefined
      ? { scoreboardSummary: seams.scoreboardSummary }
      : {}),
    ...(seams.teamJobs !== undefined ? { teamJobs: seams.teamJobs } : {}),
    ...(seams.subscribeDiscovery !== undefined
      ? { subscribeDiscovery: seams.subscribeDiscovery }
      : {}),
    ...(seams.connectPeer !== undefined ? { connectPeer: seams.connectPeer } : {}),
  };
}

/**
 * Connect configured peers and return protocol seams for the cluster rail,
 * slash commands, and runtime `cluster/connect`. Returns undefined when
 * there is nothing to discover or connect.
 *
 * **mDNS-only mode is a first-class case.** `--discovery mdns` with no
 * `--peers` must still build a cluster: the whole point of discovery is
 * that the peer list is empty at startup. Earlier revisions returned
 * `undefined` here (and later gated the rail on
 * `endpointConfigs.length > 0`), so `--discovery mdns` was a no-op in
 * exactly the configuration it exists for.
 */
export async function wirePeerCluster(
  options: WirePeerClusterOptions,
): Promise<WirePeerClusterResult | undefined> {
  const discovery: PeerDiscoveryMode = options.discovery ?? "static";
  const mdnsEnabled = discovery === "mdns";
  if (
    options.peers.length === 0 &&
    !options.enableRuntimeConnect &&
    !mdnsEnabled
  ) {
    return undefined;
  }

  let peerMod: PeerCompatModule;
  try {
    peerMod = (await import(PEER_PACKAGE)) as PeerCompatModule;
  } catch {
    throw new Error(
      "peer cluster requires @envoymesh/envoy-harness-peer (install the peer package)",
    );
  }

  const managed = new peerMod.ManagedPeerCluster({
    ...(options.connectTimeoutMs !== undefined
      ? { connectTimeoutMs: options.connectTimeoutMs }
      : {}),
    ...(options.onFailure !== undefined ? { onFailure: options.onFailure } : {}),
  });

  const endpointConfigs = options.peers.map((peer) => ({
    id: peer.id,
    endpoint: peer.endpoint,
    ...(peer.model !== undefined ? { model: peer.model } : {}),
    ...(peer.capabilities !== undefined
      ? { capabilities: peer.capabilities }
      : {}),
  }));

  let rail: { start(): Promise<void>; stop(): void } | undefined;

  // Build the rail whenever there is something to discover: static peers,
  // or mDNS browsing (which starts with an empty peer list by design).
  if (discovery !== "none" && (endpointConfigs.length > 0 || mdnsEnabled)) {
    const sources = [
      new peerMod.StaticDiscoverySource(endpointConfigs),
      ...(mdnsEnabled
        ? [
            new peerMod.MdnsDiscoverySource({
              // Discovery is a convenience: multicast may be blocked (CI,
              // hardened sandboxes, corporate WLAN). Warn, then continue.
              onError: (err: Error) => {
                options.onFailure?.("mdns", err);
              },
            }),
          ]
        : []),
    ];
    const discoveryRail = peerMod.createDiscoveryRail({
      cluster: managed,
      sources,
    });
    await discoveryRail.start();
    rail = discoveryRail;
  }

  const peerUi = managed.createUiBackend();

  const connectPeer = async (
    params: Parameters<NonNullable<ProtocolSessionBackend["connectPeer"]>>[0],
  ): Promise<
    Awaited<ReturnType<NonNullable<ProtocolSessionBackend["connectPeer"]>>>
  > => {
    return managed.connectPeer({
      id: params.id,
      endpoint: params.endpoint,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.capabilities !== undefined
        ? { capabilities: [...params.capabilities] }
        : {}),
    }) as Promise<
      Awaited<ReturnType<NonNullable<ProtocolSessionBackend["connectPeer"]>>>
    >;
  };

  const seams: ClusterSeams = {
    ...(peerUi.backend.listPeers !== undefined
      ? { listPeers: peerUi.backend.listPeers }
      : {}),
    ...(peerUi.backend.clusterStatus !== undefined
      ? { clusterStatus: peerUi.backend.clusterStatus }
      : {}),
    ...(peerUi.backend.routePeer !== undefined
      ? { routePeer: peerUi.backend.routePeer }
      : {}),
    ...(peerUi.backend.scoreboardSummary !== undefined
      ? { scoreboardSummary: peerUi.backend.scoreboardSummary }
      : {}),
    ...(peerUi.backend.teamJobs !== undefined
      ? { teamJobs: peerUi.backend.teamJobs }
      : {}),
    ...(peerUi.backend.subscribeDiscovery !== undefined
      ? { subscribeDiscovery: peerUi.backend.subscribeDiscovery }
      : {}),
    connectPeer,
  };

  return {
    seams,
    dispose: async () => {
      rail?.stop();
      peerUi.close();
      managed.closeAll();
    },
  };
}
