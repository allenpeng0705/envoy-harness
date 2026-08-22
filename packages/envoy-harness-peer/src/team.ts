/**
 * D4 — `createPeerTeamExecutor`: the `TeamOptions.peerExecutor`
 * implementation that dispatches a team agent to a standalone
 * envoy-harness peer.
 *
 * The runner (Package 1) declares the seam; this package provides it —
 * so Package 1 never depends on the peer package.
 */

import type { AgentSpec } from "@envoymesh/envoy-harness";

import type { PeerClient } from "./client.js";
import { PeerMeshSubmitter } from "./submitter.js";
import { PeerRegistry } from "./registry.js";

export interface PeerTeamExecutorOptions {
  /** Default cost ceiling for peer agents (USD). */
  defaultCostCeilingUsd?: number;
  /** Default deadline for peer agents (ms). */
  defaultDeadlineMs?: number;
  /** A signal to abort the whole team run. */
  signal?: AbortSignal;
}

export function createPeerTeamExecutor(
  registry: PeerRegistry,
  options: PeerTeamExecutorOptions = {},
): (spec: AgentSpec, prompt: string) => Promise<string> {
  const costCeilingUsd = options.defaultCostCeilingUsd ?? 1;
  const deadlineMs = options.defaultDeadlineMs ?? 60_000;

  return async (spec, prompt) => {
    if (spec.host === undefined || spec.host === "local") {
      throw new Error(`createPeerTeamExecutor: ${spec.id} is not a peer host`);
    }
    if (!spec.host.startsWith("peer://")) {
      throw new Error(
        `createPeerTeamExecutor: unknown host "${spec.host}" for agent ${spec.id}`,
      );
    }
    const peerId = spec.host.slice("peer://".length);
    const entry = registry.get(peerId);
    if (entry === undefined) {
      throw new Error(`createPeerTeamExecutor: unknown peer "${peerId}"`);
    }
    const signal = options.signal ?? new AbortController().signal;
    const submitter = new PeerMeshSubmitter({
      client: entry.client,
      workerPeerId: peerId,
    });
    const result = await submitter.submit(
      {
        objective: prompt,
        capabilityTag: spec.role,
        costCeilingUsd,
        deadlineMs,
        preferredPeerId: peerId,
      },
      signal,
    );
    const text = result.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return text;
  };
}

/** Convenience: a `PeerClient` + identity is a one-peer registry. */
export function createSinglePeerTeamExecutor(
  peerId: string,
  client: PeerClient,
  options?: PeerTeamExecutorOptions,
): (spec: AgentSpec, prompt: string) => Promise<string> {
  const registry = new PeerRegistry();
  registry.register({ id: peerId, client });
  return createPeerTeamExecutor(registry, options);
}
