/**
 * R8.2 — connect `--peers` for one-shot / REPL (parity with ACP).
 * Returns a dispose hook; no-op when no peers are configured.
 */

import type { ConfigLayer } from "../../config/index.js";
import type { RunParsedArgs } from "../argv-types.js";

export async function wireCliPeers(options: {
  parsed: RunParsedArgs;
  configLayer: ConfigLayer;
  stderr: NodeJS.WritableStream;
}): Promise<() => Promise<void>> {
  const { resolvePeerEndpoints } = await import("../../peers/resolve.js");
  const peerEndpoints = resolvePeerEndpoints({
    configLayer: options.configLayer,
    cliPeers: options.parsed.peers,
  });
  if (peerEndpoints.length === 0) {
    return async () => undefined;
  }
  const { wirePeerCluster } = await import("../../peers/wire-cluster.js");
  try {
    const wired = await wirePeerCluster({
      peers: peerEndpoints,
      discovery: options.parsed.discovery,
      ...(options.parsed.peerConnectTimeoutMs !== undefined
        ? { connectTimeoutMs: options.parsed.peerConnectTimeoutMs }
        : {}),
      onFailure: (id, err) => {
        if (!options.parsed.quiet) {
          options.stderr.write(
            `envoy-harness: peer ${id} failed: ${err.message}\n`,
          );
        }
      },
    });
    if (wired === undefined) {
      return async () => undefined;
    }
    if (!options.parsed.quiet) {
      const status = await wired.seams.clusterStatus?.();
      const n = status?.connected ?? peerEndpoints.length;
      options.stderr.write(
        `envoy-harness: peer cluster ready (${n} connected)\n`,
      );
    }
    return wired.dispose;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!options.parsed.quiet) {
      options.stderr.write(`envoy-harness: peer wire failed: ${message}\n`);
    }
    return async () => undefined;
  }
}
