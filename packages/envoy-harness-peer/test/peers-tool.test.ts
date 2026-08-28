/**
 * `peers` tool — the model-facing peer-cluster discovery surface.
 */

import { describe, expect, it } from "vitest";

import {
  createInProcessPeerPair,
  createPeersTool,
  createPeerServerHandler,
  PeerRegistry,
} from "../src/index.js";
import { stubAdapter } from "./helpers.js";

function registeredPeer(id: string, model: string, capabilities: string[]) {
  const pair = createInProcessPeerPair(
    createPeerServerHandler({
      adapter: stubAdapter(),
      identity: { peerId: id, model },
    }),
  );
  return { id, client: pair.client, model, capabilities, pair };
}

describe("createPeersTool", () => {
  it("lists id, model, and capabilities for the model to route by", async () => {
    const a = registeredPeer("p-deepseek", "deepseek-chat", ["research"]);
    const b = registeredPeer("p-claude", "claude-instant", ["research", "code"]);
    const registry = new PeerRegistry();
    registry.register(a);
    registry.register(b);
    const tool = createPeersTool(registry);

    expect(tool.name).toBe("peers");
    const result = await tool.execute({}, {} as never);
    const text = result.content as string;
    expect(text).toContain("Peers (2)");
    expect(text).toContain("- p-deepseek model=deepseek-chat capabilities=research");
    expect(text).toContain(
      "- p-claude model=claude-instant capabilities=research,code",
    );
    expect(text).toContain("task.preferred_peer_id");
    a.pair.close();
    b.pair.close();
  });

  it("shows an empty state when no peers are registered", async () => {
    const tool = createPeersTool(new PeerRegistry());
    const result = await tool.execute({}, {} as never);
    expect(result.content).toBe("Peers (0) — no peers configured");
  });

  it("respects the limit argument", async () => {
    const registry = new PeerRegistry();
    const pairs: Array<{ close(): void }> = [];
    for (let i = 0; i < 3; i++) {
      const pair = createInProcessPeerPair(
        createPeerServerHandler({
          adapter: stubAdapter(),
          identity: { peerId: `p${i}` },
        }),
      );
      pairs.push(pair);
      registry.register({ id: `p${i}`, client: pair.client });
    }
    const tool = createPeersTool(registry);
    const result = await tool.execute({ limit: 2 }, {} as never);
    expect(result.content).toContain("Peers (2)");
    expect(result.content).toContain("- p0");
    expect(result.content).not.toContain("- p2");
    for (const p of pairs) p.close();
  });
});
