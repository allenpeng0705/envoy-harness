/**
 * D3 — `PeerRegistry` + model routing ("different models collaborate").
 */

import { describe, expect, it } from "vitest";

import { PeerRegistry } from "../src/index.js";

import { createInProcessPeerPair, createPeerServerHandler } from "../src/index.js";
import { stubAdapter } from "./helpers.js";

function fakeEntry(id: string, model: string, capabilities: string[]) {
  const pair = createInProcessPeerPair(
    createPeerServerHandler({
      adapter: stubAdapter(),
      identity: { peerId: id, model },
    }),
  );
  return { id, model, capabilities, client: pair.client };
}

describe("PeerRegistry", () => {
  it("routes by model, capability, and explicit peer id", () => {
    const registry = new PeerRegistry();
    const deepseek = fakeEntry("peer-deepseek", "deepseek-chat", ["research"]);
    const claude = fakeEntry("peer-claude", "claude-instant", ["code-review"]);
    registry.register(deepseek);
    registry.register(claude);

    expect(registry.pickByModel("claude-instant")?.id).toBe("peer-claude");
    // Explicit model routing never falls back: an unknown model → none.
    expect(registry.pickByModel("unknown")).toBeUndefined();

    expect(
      registry.route({
        objective: "x",
        capabilityTag: "code-review",
        costCeilingUsd: 1,
        deadlineMs: 10_000,
      })?.id,
    ).toBe("peer-claude");

    expect(
      registry.route({
        objective: "x",
        capabilityTag: "research",
        costCeilingUsd: 1,
        deadlineMs: 10_000,
        preferredPeerId: "peer-claude",
      })?.id,
    ).toBe("peer-claude");

    expect(registry.list()).toHaveLength(2);
  });

  it("rejects duplicate ids and honors disposers", () => {
    const registry = new PeerRegistry();
    const entry = fakeEntry("p1", "m", []);
    const dispose = registry.register(entry);
    expect(() => registry.register(entry)).toThrow(/already registered/);
    dispose();
    expect(registry.list()).toHaveLength(0);
  });
});
