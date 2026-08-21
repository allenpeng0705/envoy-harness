/**
 * Phase C / Item 8 — keyless HTTP fetch provider (Node 22+ `fetch`).
 */

import type { WebFetchBody, WebFetchProvider, WebFetchResult } from "./types.js";
import { WebError } from "./types.js";

export interface HttpFetchProviderOptions {
  /** Soft cap on decoded body bytes (default 512 KiB). */
  maxBytes?: number;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_BYTES = 512 * 1024;

function classifyBody(contentType: string | null, text: string): WebFetchBody {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("html")) {
    return { kind: "html", content: text };
  }
  return { kind: "text", content: text };
}

/** Built-in keyless fetch provider. Always `available()`. */
export function createHttpFetchProvider(
  options: HttpFetchProviderOptions = {},
): WebFetchProvider {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    id: "http",
    available: () => true,
    async fetch(request, signal): Promise<WebFetchResult> {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        throw new WebError(`invalid url: ${request.url}`, "INVALID_URL");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new WebError(
          `unsupported protocol: ${url.protocol}`,
          "INVALID_URL",
        );
      }

      let response: Response;
      try {
        // exactOptionalPropertyTypes: omit `signal` when
        // undefined (RequestInit.signal is AbortSignal | null).
        response = await fetchImpl(url, {
          ...(signal !== undefined ? { signal } : {}),
          redirect: "follow",
          headers: { accept: "text/html,text/plain,*/*;q=0.8" },
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new WebError(
          err instanceof Error ? err.message : String(err),
          "FETCH_FAILED",
        );
      }

      const buf = Buffer.from(await response.arrayBuffer());
      const truncated = buf.byteLength > maxBytes;
      const slice = truncated ? buf.subarray(0, maxBytes) : buf;
      const text = slice.toString("utf8");

      return {
        url: response.url || url.toString(),
        statusCode: response.status,
        body: classifyBody(response.headers.get("content-type"), text),
        truncated,
      };
    },
  };
}
