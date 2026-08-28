/**
 * Phase G — hermetic tests for mesh credential + remote session seams.
 */

import { describe, expect, it } from "vitest";

import { createMeshCredentialsProvider } from "../src/mesh-credentials.js";
import { loadRemoteSession } from "../src/remote-session.js";

describe("createMeshCredentialsProvider", () => {
  it("fetches via transport for source mesh", async () => {
    const provider = createMeshCredentialsProvider({
      async fetch(name) {
        return `secret:${name}`;
      },
      list: () => [{ name: "brave", source: "mesh" }],
    });
    const ac = new AbortController();
    await expect(
      provider.resolve({ name: "brave", source: "mesh" }, { signal: ac.signal }),
    ).resolves.toBe("secret:brave");
    expect(provider.list()).toEqual([{ name: "brave", source: "mesh" }]);
  });

  it("rejects non-mesh sources", async () => {
    const provider = createMeshCredentialsProvider({
      async fetch() {
        return "x";
      },
    });
    const ac = new AbortController();
    await expect(
      provider.resolve({ name: "k", source: "env" }, { signal: ac.signal }),
    ).rejects.toThrow(/cannot resolve source=env/);
  });
});

describe("loadRemoteSession", () => {
  it("delegates to transport.fetch", async () => {
    const proj = await loadRemoteSession(
      {
        async fetch(ref) {
          return {
            sessionId: ref.sessionId,
            originNode: ref.originNode,
            payload: '{"ok":true}',
            checkpointAt: "2026-01-01T00:00:00.000Z",
          };
        },
      },
      { originNode: "peer-a", sessionId: "sess-1" },
    );
    expect(proj).toMatchObject({
      sessionId: "sess-1",
      originNode: "peer-a",
      payload: '{"ok":true}',
    });
  });
});
