import { describe, expect, it } from "vitest";

import { createInProcessJsonRpcPair } from "../../src/protocol/index.js";

describe("JsonRpcConnection", () => {
  it("request has a default 30s timeout and rejects when the server never replies", async () => {
    // Regression: a `request()` that never gets a response
    // would hang the host process forever. The connection
    // now applies a 30s default; override with a custom
    // timeout or `Infinity` to disable.
    const pair = createInProcessJsonRpcPair();
    try {
      // Server never replies to `hang-me`.
      pair.server.setRequestHandler(async () => new Promise(() => {}));
      await expect(
        pair.client.request("hang-me", {}, 30),
      ).rejects.toThrow(/timed out after 30ms/);
    } finally {
      pair.close();
    }
  });

  it("request honors a custom timeout override", async () => {
    const pair = createInProcessJsonRpcPair();
    try {
      pair.server.setRequestHandler(async () => new Promise(() => {}));
      await expect(
        pair.client.request("hang-me", {}, 20),
      ).rejects.toThrow(/timed out after 20ms/);
    } finally {
      pair.close();
    }
  });

  it("request with Infinity timeout does not time out", async () => {
    const pair = createInProcessJsonRpcPair();
    try {
      // Server replies after 50ms.
      pair.server.setRequestHandler(
        async () =>
          new Promise((resolve) => setTimeout(() => resolve("late"), 50)),
      );
      const result = await pair.client.request("eventually", {}, Infinity);
      expect(result).toBe("late");
    } finally {
      pair.close();
    }
  });
});
