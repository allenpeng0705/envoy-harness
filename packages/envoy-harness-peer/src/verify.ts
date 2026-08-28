/**
 * D5 — cross-instance verification: an orchestrator asks a peer (with a
 * DIFFERENT model, when routed that way) to verify a result via
 * `peer/verify`. The standalone analog of the mesh's chainVerify.
 */

import type { SignedAgentResult } from "@envoymesh/protocol";
import type { Verdict } from "@envoymesh/protocol";

import type { PeerRegistry } from "./registry.js";

export interface CrossVerifyRequest {
  /** The result to verify (typically produced by a peer/team agent). */
  result: SignedAgentResult;
  /** The task's objective (the verifier's prompt). */
  objective: string;
  /** Route to a peer whose model matches (the "different model" picker). */
  verifierModel?: string;
  /** Or route to an explicit verifier peer. */
  verifierPeerId?: string;
  signal?: AbortSignal;
}

export interface CrossVerifyOutcome {
  verdicts: Verdict[];
  /** The peer that verified. */
  verifierPeerId: string;
  /** The verifier's model (advertised by that peer). */
  verifierModel?: string;
}

export type CrossInstanceVerifier = (
  request: CrossVerifyRequest,
) => Promise<CrossVerifyOutcome>;

export function createCrossInstanceVerifier(
  registry: PeerRegistry,
): CrossInstanceVerifier {
  return async (request) => {
    const entry =
      request.verifierPeerId !== undefined
        ? registry.get(request.verifierPeerId)
        : request.verifierModel !== undefined
          ? registry.pickByModel(request.verifierModel)
          : undefined;
    if (entry === undefined) {
      const hint =
        request.verifierModel !== undefined
          ? ` (model ${request.verifierModel})`
          : "";
      throw new Error(`no peer available for cross-instance verify${hint}`);
    }
    const verdicts = await entry.client.verify(
      { result: request.result, objective: request.objective },
      request.signal,
    );
    return {
      verdicts,
      verifierPeerId: entry.id,
      ...(entry.model !== undefined ? { verifierModel: entry.model } : {}),
    };
  };
}
