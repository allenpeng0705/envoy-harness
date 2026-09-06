/**
 * Discovery subscribe unwrapping contract (mirrors EnvoyHarnessClient).
 */
import { describe, expect, it } from "vitest";

function unwrapDiscoveryEvent(params: unknown): unknown {
  const { event } = (params ?? {}) as { event?: unknown };
  if (event !== undefined) return event;
  if (
    params !== null &&
    typeof params === "object" &&
    "type" in (params as object)
  ) {
    return params;
  }
  return undefined;
}

describe("discovery event unwrap", () => {
  it("unwraps { event }", () => {
    const event = { type: "peer.connected", peerId: "a", at: "t" };
    expect(unwrapDiscoveryEvent({ event })).toEqual(event);
  });

  it("accepts bare event objects", () => {
    const event = { type: "peer.failed", peerId: "b", at: "t" };
    expect(unwrapDiscoveryEvent(event)).toEqual(event);
  });

  it("returns undefined for empty", () => {
    expect(unwrapDiscoveryEvent({})).toBeUndefined();
  });
});
