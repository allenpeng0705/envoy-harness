/**
 * Connect peer clusters and merge cluster protocol seams into ACP backends.
 */

import {
  createFakeSessionBackend,
  mergeClusterSeams,
  type ProtocolSessionBackend,
  wirePeerCluster,
  type ResolvedPeerEndpoint,
} from "@envoymesh/envoy-harness";

import { createInProcessTui, type InProcessTui } from "./in-process.js";

export interface WireClusterBackendOptions {
  peers: ReadonlyArray<ResolvedPeerEndpoint>;
  connectTimeoutMs?: number;
  enableRuntimeConnect?: boolean;
  discovery?: "static" | "mdns" | "none";
  base?: ProtocolSessionBackend;
  onFailure?: (id: string, err: Error) => void;
}

export interface WiredClusterBackend {
  backend: ProtocolSessionBackend;
  dispose: () => Promise<void>;
}

/** Connect peers and merge cluster seams onto an optional base backend. */
export async function wireClusterBackend(
  options: WireClusterBackendOptions,
): Promise<WiredClusterBackend> {
  const base = options.base ?? createFakeSessionBackend();
  const wired = await wirePeerCluster({
    peers: options.peers,
    ...(options.connectTimeoutMs !== undefined
      ? { connectTimeoutMs: options.connectTimeoutMs }
      : {}),
    ...(options.enableRuntimeConnect === true
      ? { enableRuntimeConnect: true }
      : {}),
    ...(options.discovery !== undefined ? { discovery: options.discovery } : {}),
    ...(options.onFailure !== undefined ? { onFailure: options.onFailure } : {}),
  });

  if (wired === undefined) {
    return {
      backend: base,
      dispose: async () => undefined,
    };
  }

  return {
    backend: mergeClusterSeams(base, wired.seams),
    dispose: wired.dispose,
  };
}

export interface ClusterTuiOptions {
  peers: ReadonlyArray<ResolvedPeerEndpoint>;
  connectTimeoutMs?: number;
  cwd?: string;
  base?: ProtocolSessionBackend;
  onFailure?: (id: string, err: Error) => void;
}

export interface ClusterTui extends InProcessTui {
  disposeCluster: () => Promise<void>;
}

/** In-process TUI with a live peer cluster wired into the ACP backend. */
export async function createClusterTui(
  options: ClusterTuiOptions,
): Promise<ClusterTui> {
  const wired = await wireClusterBackend(options);
  const tui = createInProcessTui({
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    backend: wired.backend,
  });

  return {
    ...tui,
    disposeCluster: wired.dispose,
    close() {
      tui.close();
      void wired.dispose().catch(() => undefined);
    },
  };
}
