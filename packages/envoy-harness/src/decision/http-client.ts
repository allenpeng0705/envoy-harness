/**
 * HTTP DecisionClient for Laya serve and TypeSafe Jev.
 * Both speak POST `/v1/systemone` with the same question shapes.
 */

import type {
  DecisionAnswer,
  DecisionBackendKind,
  DecisionClient,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
} from "./types.js";

export interface HttpDecisionClientOptions {
  /** `laya-http` or `jev` (affects default model + id). */
  kind: "laya-http" | "jev";
  /** Full URL ending in `/v1/systemone`, or base URL we append to. */
  endpoint: string;
  /** Bearer token (already resolved from env by the factory). */
  apiKey?: string;
  /** Default model field when the request has no modelHint. */
  defaultModel?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/systemone")) return trimmed;
  return `${trimmed}/v1/systemone`;
}

function parseAnswer(raw: unknown): DecisionAnswer | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const type = obj["type"];
  if (type === "choice" && typeof obj["choice"] === "string") {
    const probs =
      obj["probabilities"] !== null &&
      typeof obj["probabilities"] === "object" &&
      !Array.isArray(obj["probabilities"])
        ? (obj["probabilities"] as Record<string, number>)
        : {};
    return {
      type: "choice",
      choice: obj["choice"],
      probabilities: probs,
      ...(typeof obj["confidence"] === "number"
        ? { confidence: obj["confidence"] }
        : {}),
    };
  }
  if (type === "score" && typeof obj["score"] === "number") {
    const dist =
      obj["distribution"] !== null &&
      typeof obj["distribution"] === "object" &&
      !Array.isArray(obj["distribution"])
        ? (obj["distribution"] as Record<string, number>)
        : {};
    return {
      type: "score",
      score: obj["score"],
      distribution: dist,
      ...(typeof obj["confidence"] === "number"
        ? { confidence: obj["confidence"] }
        : {}),
    };
  }
  if (type === "noul" && typeof obj["noul"] === "number") {
    return { type: "noul", noul: obj["noul"] };
  }
  // Some responses omit type but include noul/choice.
  if (typeof obj["noul"] === "number") {
    return { type: "noul", noul: obj["noul"] };
  }
  if (typeof obj["choice"] === "string") {
    return {
      type: "choice",
      choice: obj["choice"],
      probabilities: {},
    };
  }
  return undefined;
}

export class HttpDecisionClient implements DecisionClient {
  readonly id: DecisionBackendKind;
  readonly #url: string;
  readonly #apiKey: string | undefined;
  readonly #defaultModel: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: HttpDecisionClientOptions) {
    this.id = options.kind;
    this.#url = normalizeEndpoint(options.endpoint);
    this.#apiKey = options.apiKey;
    this.#defaultModel =
      options.defaultModel ??
      (options.kind === "jev" ? "jev-latest" : undefined);
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async predict(req: DecisionRequest): Promise<DecisionResponse> {
    const started = Date.now();
    const model = req.modelHint ?? this.#defaultModel;
    const body: Record<string, unknown> = {
      state: req.state,
      questions: req.questions as Record<string, DecisionQuestion>,
    };
    if (model !== undefined) body["model"] = model;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.#apiKey !== undefined && this.#apiKey.length > 0) {
      headers["Authorization"] = `Bearer ${this.#apiKey}`;
    }

    const res = await this.#fetch(this.#url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `decision HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`,
      );
    }
    const json = (await res.json()) as {
      answers?: Record<string, unknown>;
      model?: string;
      usage?: { input_tokens?: number; inputTokens?: number };
    };
    const answers: Record<string, DecisionAnswer> = {};
    if (json.answers !== undefined) {
      for (const [k, v] of Object.entries(json.answers)) {
        const parsed = parseAnswer(v);
        if (parsed !== undefined) answers[k] = parsed;
      }
    }
    const inputTokens =
      json.usage?.inputTokens ?? json.usage?.input_tokens ?? undefined;
    return {
      answers,
      backend: this.id,
      ...(typeof json.model === "string" ? { model: json.model } : {}),
      usage: {
        latencyMs: Date.now() - started,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
      },
    };
  }
}
