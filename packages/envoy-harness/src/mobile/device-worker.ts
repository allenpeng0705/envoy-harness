/**
 * Phase 3 — mesh device-worker peer helpers.
 *
 * A machine with Xcode / Android SDK advertises capability
 * `device-worker` and exposes the same `device_*` tools so a laptop
 * agent can submit long builds / UI tests remotely via the existing
 * mesh ladder (`LocalMeshSubmitter` → `PeerMeshSubmitter`).
 */

import { MOBILE_DEVICE_TOOL_NAMES } from "../tools/builtin/mobile/index.js";

/** Capability tag for PeerRegistry / mDNS routing. */
export const DEVICE_WORKER_CAPABILITY = "device-worker";

/** Mesh skill id advertised by envoy-harness-adapter. */
export const DEVICE_DEBUG_SKILL_ID = "device-debug";

/** Tool names a device-worker peer should expose. */
export const DEVICE_WORKER_TOOL_NAMES = MOBILE_DEVICE_TOOL_NAMES;

export interface DeviceWorkerAdvertiseOptions {
  /** Extra capability tags merged with `device-worker`. */
  extraCapabilities?: ReadonlyArray<string>;
}

/** Capabilities list for mDNS / peer registry advertise. */
export function deviceWorkerCapabilities(
  opts: DeviceWorkerAdvertiseOptions = {},
): string[] {
  const caps = new Set<string>([DEVICE_WORKER_CAPABILITY]);
  for (const c of opts.extraCapabilities ?? []) {
    if (c.trim().length > 0) caps.add(c.trim());
  }
  return [...caps];
}

/**
 * Suggested `task` routing hint for the model when a device-worker
 * peer is in the cluster.
 */
export function deviceWorkerRoutingHint(): string {
  return (
    `Route long mobile builds / UI tests to a peer with capability ` +
    `"${DEVICE_WORKER_CAPABILITY}" (skill "${DEVICE_DEBUG_SKILL_ID}") via ` +
    `task.preferred_peer_id or capability_tag.`
  );
}
