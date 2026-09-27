import type {
  DecisionAnswer,
  DecisionClient,
  DecisionRequest,
  DecisionResponse,
} from "./types.js";

/**
 * Test double: returns a fixed answer map (or a function of the request).
 */
export class FakeDecisionClient implements DecisionClient {
  readonly id = "fake";
  calls: DecisionRequest[] = [];

  constructor(
    private readonly answers:
      | Record<string, DecisionAnswer>
      | ((req: DecisionRequest) => Record<string, DecisionAnswer>),
  ) {}

  async predict(req: DecisionRequest): Promise<DecisionResponse> {
    this.calls.push(req);
    if (req.signal?.aborted) {
      throw new Error("aborted");
    }
    const answers =
      typeof this.answers === "function" ? this.answers(req) : this.answers;
    return { answers, backend: this.id };
  }
}
