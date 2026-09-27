import type { DecisionClient, DecisionRequest, DecisionResponse } from "./types.js";

/** Default client — no network, empty answers (consumers use incumbent policy). */
export class NullDecisionClient implements DecisionClient {
  readonly id = "null";

  async predict(_req: DecisionRequest): Promise<DecisionResponse> {
    return { answers: {}, backend: this.id };
  }
}
