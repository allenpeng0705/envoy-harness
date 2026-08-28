/**
 * Phase C / Item 8 — {@link WebRuntime} with provider selection.
 */

import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebRuntime,
  WebRuntimeConfig,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from "./types.js";
import { WebError } from "./types.js";

function selectProvider<T extends { id: string; available(): boolean }>(
  kind: "search" | "fetch",
  providers: Map<string, T>,
  configuredId: string | undefined,
): T {
  if (configuredId !== undefined) {
    const p = providers.get(configuredId);
    if (p === undefined) {
      throw new WebError(
        `${kind} provider '${configuredId}' is not registered`,
        "PROVIDER_MISSING",
      );
    }
    if (!p.available()) {
      throw new WebError(
        `${kind} provider '${configuredId}' is unavailable`,
        "PROVIDER_UNAVAILABLE",
      );
    }
    return p;
  }

  const usable = [...providers.values()].filter((p) => p.available());
  if (usable.length === 0) {
    throw new WebError(`no ${kind} provider available`, "PROVIDER_UNAVAILABLE");
  }
  if (usable.length > 1) {
    throw new WebError(
      `multiple ${kind} providers available (${usable.map((p) => p.id).join(", ")}); configure one`,
      "PROVIDER_AMBIGUOUS",
    );
  }
  return usable[0]!;
}

/** Create a provider-neutral web runtime. */
export function createWebRuntime(config: WebRuntimeConfig = {}): WebRuntime {
  const searchProviders = new Map<string, WebSearchProvider>();
  const fetchProviders = new Map<string, WebFetchProvider>();

  return {
    registerSearchProvider(provider) {
      if (searchProviders.has(provider.id)) {
        throw new WebError(
          `duplicate search provider '${provider.id}'`,
          "DUPLICATE_PROVIDER",
        );
      }
      searchProviders.set(provider.id, provider);
      return () => {
        searchProviders.delete(provider.id);
      };
    },

    registerFetchProvider(provider) {
      if (fetchProviders.has(provider.id)) {
        throw new WebError(
          `duplicate fetch provider '${provider.id}'`,
          "DUPLICATE_PROVIDER",
        );
      }
      fetchProviders.set(provider.id, provider);
      return () => {
        fetchProviders.delete(provider.id);
      };
    },

    async search(request, signal) {
      const provider = selectProvider(
        "search",
        searchProviders,
        config.searchProvider,
      );
      const result = await provider.search(request, signal);
      if (request.maxResults === undefined) return result;
      if (result.sources.length <= request.maxResults) return result;
      return {
        ...result,
        sources: result.sources.slice(0, request.maxResults),
        truncated: true,
      };
    },

    async fetch(request, signal) {
      const provider = selectProvider(
        "fetch",
        fetchProviders,
        config.fetchProvider,
      );
      return provider.fetch(request, signal);
    },
  };
}

/** Test helper: a search provider with controllable availability. */
export function createFakeSearchProvider(options: {
  id: string;
  available?: boolean;
  search?: (
    request: WebSearchRequest,
    signal?: AbortSignal,
  ) => Promise<WebSearchResult>;
}): WebSearchProvider {
  return {
    id: options.id,
    available: () => options.available ?? true,
    search:
      options.search ??
      (async () => ({ sources: [], truncated: false })),
  };
}

/** Test helper: a fetch provider with controllable availability. */
export function createFakeFetchProvider(options: {
  id: string;
  available?: boolean;
  fetch?: (
    request: WebFetchRequest,
    signal?: AbortSignal,
  ) => Promise<WebFetchResult>;
}): WebFetchProvider {
  return {
    id: options.id,
    available: () => options.available ?? true,
    fetch:
      options.fetch ??
      (async (req) => ({
        url: req.url,
        statusCode: 200,
        body: { kind: "text" as const, content: "" },
        truncated: false,
      })),
  };
}
