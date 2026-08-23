/**
 * Merge peer endpoints from config, env, and CLI (later sources override id).
 */

import type { ConfigLayer } from "../config/schema.js";
import type { PeerEndpointSpec } from "./endpoints.js";
import { parsePeerEndpointsFromEnv } from "./endpoints.js";

export interface ResolvedPeerEndpoint extends PeerEndpointSpec {
  model?: string;
  capabilities?: string[];
}

/** Read `[[peers]]` entries from a loaded config layer. */
export function peersFromConfigLayer(layer: ConfigLayer): ResolvedPeerEndpoint[] {
  if (layer.peers === undefined) return [];
  return layer.peers.map((peer) => ({
    id: peer.id,
    endpoint: peer.endpoint,
    ...(peer.model !== undefined ? { model: peer.model } : {}),
    ...(peer.capabilities !== undefined ? { capabilities: peer.capabilities } : {}),
  }));
}

export interface ResolvePeerEndpointsOptions {
  configLayer?: ConfigLayer;
  cliPeers?: ReadonlyArray<PeerEndpointSpec>;
  env?: NodeJS.ProcessEnv;
}

/** Union config + env + CLI peer endpoints (CLI wins on duplicate ids). */
export function resolvePeerEndpoints(
  options: ResolvePeerEndpointsOptions = {},
): ResolvedPeerEndpoint[] {
  const byId = new Map<string, ResolvedPeerEndpoint>();
  for (const peer of peersFromConfigLayer(options.configLayer ?? {})) {
    byId.set(peer.id, peer);
  }
  for (const peer of parsePeerEndpointsFromEnv(options.env)) {
    byId.set(peer.id, peer);
  }
  for (const peer of options.cliPeers ?? []) {
    byId.set(peer.id, { id: peer.id, endpoint: peer.endpoint });
  }
  return [...byId.values()];
}
