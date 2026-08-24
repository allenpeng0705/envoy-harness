/**
 * Perplexity Sonar search provider (chat-completions API).
 */

import type { CredentialsProvider } from "../credentials/types.js";
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from "./types.js";
import { WebError } from "./types.js";

const PERPLEXITY_KEY_NAME = "PERPLEXITY_API_KEY";
const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";

export interface PerplexitySearchProviderOptions {
  credentials?: CredentialsProvider & {
    resolveByName?(
      name: string,
      opts: { signal: AbortSignal },
    ): Promise<string>;
  };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  model?: string;
}

interface PerplexityCitation {
  url?: string;
  title?: string;
}

interface PerplexityResponse {
  citations?: PerplexityCitation[];
  choices?: Array<{ message?: { content?: string } }>;
}

export function createPerplexitySearchProvider(
  options: PerplexitySearchProviderOptions = {},
): WebSearchProvider {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const model = options.model ?? "sonar";

  async function resolveKey(signal: AbortSignal): Promise<string> {
    const fromEnv = env[PERPLEXITY_KEY_NAME];
    if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
    const creds = options.credentials;
    if (creds?.resolveByName !== undefined) {
      return creds.resolveByName(PERPLEXITY_KEY_NAME, { signal });
    }
    if (creds !== undefined) {
      return creds.resolve(
        { name: PERPLEXITY_KEY_NAME, source: "env" },
        { signal },
      );
    }
    throw new WebError(
      `${PERPLEXITY_KEY_NAME} is not set`,
      "PROVIDER_UNAVAILABLE",
    );
  }

  return {
    id: "perplexity",
    available(): boolean {
      const fromEnv = env[PERPLEXITY_KEY_NAME];
      if (typeof fromEnv === "string" && fromEnv.length > 0) return true;
      const refs = options.credentials?.list() ?? [];
      return refs.some(
        (r) => r.name === PERPLEXITY_KEY_NAME && r.source === "file",
      );
    },
    async search(
      request: WebSearchRequest,
      signal: AbortSignal,
    ): Promise<WebSearchResult> {
      const key = await resolveKey(signal);
      const res = await fetchImpl(PERPLEXITY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: `Search and summarize: ${request.query}`,
            },
          ],
        }),
        signal,
      });
      if (!res.ok) {
        throw new WebError(
          `Perplexity search failed: ${res.status}`,
          "FETCH_FAILED",
        );
      }
      const data = (await res.json()) as PerplexityResponse;
      const summary = data.choices?.[0]?.message?.content ?? "";
      const citations = data.citations ?? [];
      const sources: WebSearchSource[] =
        citations.length > 0
          ? citations.map((c) => ({
              url: c.url ?? "",
              title: c.title ?? c.url ?? "source",
              snippet: "",
            }))
          : summary.length > 0
            ? [{ url: "", title: "Perplexity summary", snippet: summary }]
            : [];
      return {
        ...(summary.length > 0 ? { content: summary } : {}),
        sources,
        truncated: false,
      };
    },
  };
}
