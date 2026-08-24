import { describe, expect, it } from "vitest";

import { resolvePeerEndpoints } from "../src/peers/resolve.js";

describe("resolvePeerEndpoints", () => {
  it("merges config, env, and CLI with CLI winning on id", () => {
    const peers = resolvePeerEndpoints({
      configLayer: {
        peers: [
          { id: "a", endpoint: "1.1.1.1:1", model: "m1" },
          { id: "b", endpoint: "2.2.2.2:2" },
        ],
      },
      cliPeers: [{ id: "a", endpoint: "9.9.9.9:9" }],
      env: { ENVOY_PEERS: "c@3.3.3.3:3" },
    });
    expect(peers).toEqual([
      { id: "a", endpoint: "9.9.9.9:9" },
      { id: "b", endpoint: "2.2.2.2:2" },
      { id: "c", endpoint: "3.3.3.3:3" },
    ]);
  });
});
