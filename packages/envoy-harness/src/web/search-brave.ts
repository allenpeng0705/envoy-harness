/**
 * Phase C / Item 8+13 — Brave Search API provider.
 *
 * Hermetic by default: `available()` is a cheap local
 * check (env var or credentials list). Live HTTP only
 * runs inside `search()` when a key resolves.
 */

import type { CredentialsProvider } from "../credentials/types.js";
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from "./types.js";
import { WebError } from "./types.js";

const BRAVE_KEY_NAME = "BRAVE_SEARCH_API_KEY";
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

export interface BraveSearchProviderOptions {
  /** Credentials cascade (env → file → ask). */
  credentials?: CredentialsProvider & {
    resolveByName?(
      name: string,
      opts: { signal: AbortSignal },
    ): Promise<string>;
  };
  /** Override env for `available()` / key resolution (tests). */
  env?: NodeJS.ProcessEnv;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] };
}

/**
 * Create a Brave Search {@link WebSearchProvider}.
 * `id` is always `"brave"`.
 */
export function createBraveSearchProvider(
  options: BraveSearchProviderOptions = {},
): WebSearchProvider {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function resolveKey(signal: AbortSignal): Promise<string> {
    const fromEnv = env[BRAVE_KEY_NAME];
    if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;

    const creds = options.credentials;
    if (creds?.resolveByName !== undefined) {
      return creds.resolveByName(BRAVE_KEY_NAME, { signal });
    }
    if (creds !== undefined) {
      return creds.resolve(
        { name: BRAVE_KEY_NAME, source: "env" },
        { signal },
      );
    }
    throw new WebError(
      `${BRAVE_KEY_NAME} is not set`,
      "PROVIDER_UNAVAILABLE",
    );
  }

  return {
    id: "brave",
    available(): boolean {
      const fromEnv = env[BRAVE_KEY_NAME];
      if (typeof fromEnv === "string" && fromEnv.length > 0) return true;
      // Cheap, no network: advertise only if credentials
      // already list the key (env knownNames / file cache).
      const refs = options.credentials?.list() ?? [];
      return refs.some((r) => r.name === BRAVE_KEY_NAME);
    },
    async search(
      request: WebSearchRequest,
      signal?: AbortSignal,
    ): Promise<WebSearchResult> {
      const abort = signal ?? AbortSignal.timeout(30_000);
      const apiKey = await resolveKey(abort);
      const url = new URL(BRAVE_SEARCH_URL);
      url.searchParams.set("q", request.query);
      if (request.maxResults !== undefined) {
        url.searchParams.set(
          "count",
          String(Math.min(Math.max(1, request.maxResults), 20)),
        );
      }

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
          signal: abort,
        });
      } catch (err) {
        if (abort.aborted) throw err;
        throw new WebError(
          err instanceof Error ? err.message : String(err),
          "FETCH_FAILED",
        );
      }

      if (!response.ok) {
        throw new WebError(
          `Brave Search HTTP ${response.status}`,
          "FETCH_FAILED",
        );
      }

      const body = (await response.json()) as BraveSearchResponse;
      const raw = body.web?.results ?? [];
      const sources: WebSearchSource[] = [];
      for (const r of raw) {
        if (typeof r.url !== "string" || r.url.length === 0) continue;
        const source: WebSearchSource = {
          url: r.url,
          ...(typeof r.title === "string" ? { title: r.title } : {}),
          ...(typeof r.description === "string"
            ? { snippet: r.description }
            : {}),
          ...(typeof r.age === "string" ? { publishedAt: r.age } : {}),
        };
        sources.push(source);
      }

      return { sources, truncated: false };
    },
  };
}
