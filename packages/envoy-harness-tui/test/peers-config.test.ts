import { describe, expect, it } from "vitest";

import {
  formatPeersForEnv,
  parseTuiPeerFlags,
} from "../src/peers-config.js";
import { renderMeshView } from "../src/views.js";

describe("parseTuiPeerFlags", () => {
  it("parses repeatable --peers flags", () => {
    const parsed = parseTuiPeerFlags([
      "--peers",
      "p1@127.0.0.1:18123",
      "--peer",
      "p2@127.0.0.1:18124",
    ]);
    expect(parsed.peers).toEqual([
      { id: "p1", endpoint: "127.0.0.1:18123" },
      { id: "p2", endpoint: "127.0.0.1:18124" },
    ]);
  });

  it("detects cluster-only mode", () => {
    expect(parseTuiPeerFlags(["--cluster-only"]).clusterOnly).toBe(true);
    expect(parseTuiPeerFlags(["--cluster"]).clusterOnly).toBe(true);
  });

  it("formats peers for ENVOY_PEERS", () => {
    expect(
      formatPeersForEnv([
        { id: "a", endpoint: "127.0.0.1:1" },
        { id: "b", endpoint: "127.0.0.1:2" },
      ]),
    ).toBe("a@127.0.0.1:1,b@127.0.0.1:2");
  });
});

describe("renderMeshView", () => {
  it("includes configured peers and live status", () => {
    const lines = renderMeshView({
      configuredPeers: [{ id: "w1", endpoint: "127.0.0.1:18123" }],
      connected: 1,
      failed: 0,
    });
    expect(lines.join("\n")).toContain("w1 → 127.0.0.1:18123");
    expect(lines.join("\n")).toContain("connected 1");
  });
});
