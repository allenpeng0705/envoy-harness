import { describe, expect, it } from "vitest";

import {
  parsePeerEndpoint,
  parsePeerEndpointsFromEnv,
  parsePeerEndpointsList,
} from "../src/peers/endpoints.js";

describe("parsePeerEndpoint", () => {
  it("parses id@host:port", () => {
    expect(parsePeerEndpoint("worker@127.0.0.1:18123")).toEqual({
      id: "worker",
      endpoint: "127.0.0.1:18123",
    });
  });

  it("rejects invalid shapes", () => {
    expect(() => parsePeerEndpoint("nope")).toThrow(/expected/);
    expect(() => parsePeerEndpoint("id@host")).toThrow(/host:port/);
  });
});

describe("parsePeerEndpointsList", () => {
  it("parses comma and whitespace separated lists", () => {
    expect(
      parsePeerEndpointsList("a@1.1.1.1:1, b@2.2.2.2:2"),
    ).toEqual([
      { id: "a", endpoint: "1.1.1.1:1" },
      { id: "b", endpoint: "2.2.2.2:2" },
    ]);
  });
});

describe("parsePeerEndpointsFromEnv", () => {
  it("reads ENVOY_PEERS", () => {
    expect(
      parsePeerEndpointsFromEnv({
        ENVOY_PEERS: "p@127.0.0.1:99",
      }),
    ).toEqual([{ id: "p", endpoint: "127.0.0.1:99" }]);
  });
});
