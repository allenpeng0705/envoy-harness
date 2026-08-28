/**
 * D3 — `PeerRegistry`: discoverable peers + model routing.
 *
 * The standalone analog of the mesh's capability-manifest routing: peers
 * announce `{ id, model, capabilities }`; an orchestrator routes a
 * subtask to the peer whose model/capability matches.
 */

import type { SubagentInput } from "@envoymesh/envoy-harness";

import type { PeerClient } from "./client.js";

export interface PeerEntry {
  /** Stable peer id. */
  id: string;
  /** The typed client to talk to this peer. */
  client: PeerClient;
  /** The peer's model (e.g. `"deepseek-chat"`) for routing. */
  model?: string;
  /** Capability tags the peer can run. */
  capabilities?: ReadonlyArray<string>;
}

export class PeerRegistry {
  readonly #peers = new Map<string, PeerEntry>();

  register(entry: PeerEntry): () => void {
    if (this.#peers.has(entry.id)) {
      throw new Error(`peer already registered: ${entry.id}`);
    }
    this.#peers.set(entry.id, entry);
    return () => {
      if (this.#peers.get(entry.id) === entry) {
        this.#peers.delete(entry.id);
      }
    };
  }

  get(id: string): PeerEntry | undefined {
    return this.#peers.get(id);
  }

  list(): ReadonlyArray<PeerEntry> {
    return [...this.#peers.values()];
  }

  /**
   * Route a `MeshSubmitter` input to a peer. Preference order:
   * 1. `input.preferredPeerId` (explicit).
   * 2. A peer whose capabilities include the task tag or the routing
   *    hint's worker capability tag.
   * 3. Any peer (first registered).
   */
  route(input: SubagentInput): PeerEntry | undefined {
    if (input.preferredPeerId !== undefined) {
      const explicit = this.#peers.get(input.preferredPeerId);
      if (explicit !== undefined) return explicit;
    }
    const wantedTags = [
      input.capabilityTag,
      input.routingHint?.workerCapabilityTag,
    ].filter((t): t is string => t !== undefined);
    const byCapability = [...this.#peers.values()].find(
      (p) =>
        p.capabilities?.some((c) => wantedTags.includes(c)) ?? false,
    );
    if (byCapability !== undefined) return byCapability;
    return [...this.#peers.values()][0];
  }

  /** Explicit model routing — the "different models collaborate" picker. */
  pickByModel(model: string): PeerEntry | undefined {
    if (model === "") return undefined;
    return [...this.#peers.values()].find((p) => p.model === model);
  }
}
