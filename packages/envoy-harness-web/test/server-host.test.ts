/**
 * The non-loopback warning is the safety net for the project registry: the
 * API can add any absolute directory, which is right for the operator at
 * this machine and needs a bound once anyone else can reach the port.
 */

import { describe, expect, it } from "vitest";

import { isLoopbackHost } from "../src/server/host.js";

describe("isLoopbackHost", () => {
  it("accepts the loopback forms", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it("rejects anything reachable from elsewhere", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it("does not treat a lookalike prefix as loopback", () => {
    // 127.0.0.1.evil.com must not pass a naive startsWith check that is not
    // anchored on the "127." label boundary.
    expect(isLoopbackHost("2127.0.0.1")).toBe(false);
    expect(isLoopbackHost("1270.0.0.1")).toBe(false);
  });
});
