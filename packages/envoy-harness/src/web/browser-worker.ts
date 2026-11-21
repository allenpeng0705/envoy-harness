/**
 * Phase 3 — mesh browser-worker peer helpers.
 *
 * A machine with Playwright/Chromium advertises capability
 * `browser-worker` and exposes the same `browser_*` tools so a laptop
 * agent can drive remote UI debug via the existing mesh ladder.
 */

import { BROWSER_TOOL_NAMES } from "../tools/builtin/browser/index.js";

/** Capability tag for PeerRegistry / mDNS routing. */
export const BROWSER_WORKER_CAPABILITY = "browser-worker";

/** Mesh skill id advertised by envoy-harness-adapter. */
export const BROWSER_DEBUG_SKILL_ID = "browser-debug";

/** Tool names a browser-worker peer should expose. */
export const BROWSER_WORKER_TOOL_NAMES = BROWSER_TOOL_NAMES;

export interface BrowserWorkerAdvertiseOptions {
  /** Extra capability tags merged with `browser-worker`. */
  extraCapabilities?: ReadonlyArray<string>;
}

/** Capabilities list for mDNS / peer registry advertise. */
export function browserWorkerCapabilities(
  opts: BrowserWorkerAdvertiseOptions = {},
): string[] {
  const caps = new Set<string>([BROWSER_WORKER_CAPABILITY]);
  for (const c of opts.extraCapabilities ?? []) {
    if (c.trim().length > 0) caps.add(c.trim());
  }
  return [...caps];
}

/**
 * Suggested `task` routing hint for the model when a browser-worker
 * peer is in the cluster.
 */
export function browserWorkerRoutingHint(): string {
  return (
    `Route long browser UI debug / screenshots to a peer with capability ` +
    `"${BROWSER_WORKER_CAPABILITY}" (skill "${BROWSER_DEBUG_SKILL_ID}") via ` +
    `task.preferred_peer_id or capability_tag.`
  );
}
