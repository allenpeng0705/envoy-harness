/**
 * Wave 3 — in-process loopback remote job transport.
 *
 * Proxies `peer://self/jobs/<id>` (and any attached peer ids) to local
 * {@link JobRegistry} instances. Live MAP/libp2p remains host-injected.
 */

import type { JobRegistry } from "./types.js";
import { FakeRemoteJobTransport, type RemoteJobTransport } from "./remote.js";

export interface LoopbackRemoteJobTransportOptions {
  /** Default peer id for this process. Default `self`. */
  selfPeerId?: string;
  registry: JobRegistry;
  viewer?: string;
}

/** Create a loopback transport with the local registry attached as `self`. */
export function createLoopbackRemoteJobTransport(
  options: LoopbackRemoteJobTransportOptions,
): FakeRemoteJobTransport & RemoteJobTransport {
  const transport = new FakeRemoteJobTransport();
  const peerId = options.selfPeerId ?? "self";
  transport.attachPeer(peerId, options.registry, {
    ...(options.viewer !== undefined ? { viewer: options.viewer } : {}),
  });
  return transport;
}
