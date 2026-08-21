/**
 * Phase C / Item 8 — web runtime provider-selection tests.
 */

import { describe, expect, it } from "vitest";

import {
  createFakeFetchProvider,
  createFakeSearchProvider,
  createWebRuntime,
  WebError,
} from "../../src/web/index.js";

describe("createWebRuntime", () => {
  it("auto-selects the only available search provider", async () => {
    const runtime = createWebRuntime();
    runtime.registerSearchProvider(
      createFakeSearchProvider({
        id: "fake",
        search: async () => ({
          sources: [{ url: "https://example.com", title: "ex" }],
          truncated: false,
        }),
      }),
    );
    const result = await runtime.search({ query: "hello", maxResults: 3 });
    expect(result.sources).toHaveLength(1);
  });

  it("errors when search providers are ambiguous", async () => {
    const runtime = createWebRuntime();
    runtime.registerSearchProvider(createFakeSearchProvider({ id: "a" }));
    runtime.registerSearchProvider(createFakeSearchProvider({ id: "b" }));
    await expect(runtime.search({ query: "x" })).rejects.toMatchObject({
      code: "PROVIDER_AMBIGUOUS",
    });
  });

  it("honors configured search provider id", async () => {
    const runtime = createWebRuntime({ searchProvider: "b" });
    runtime.registerSearchProvider(
      createFakeSearchProvider({
        id: "a",
        search: async () => ({
          sources: [{ url: "https://a.test" }],
          truncated: false,
        }),
      }),
    );
    runtime.registerSearchProvider(
      createFakeSearchProvider({
        id: "b",
        search: async () => ({
          sources: [{ url: "https://b.test" }],
          truncated: false,
        }),
      }),
    );
    const result = await runtime.search({ query: "x" });
    expect(result.sources[0]?.url).toBe("https://b.test");
  });

  it("truncates search sources to maxResults", async () => {
    const runtime = createWebRuntime();
    runtime.registerSearchProvider(
      createFakeSearchProvider({
        id: "fake",
        search: async () => ({
          sources: [
            { url: "https://1.test" },
            { url: "https://2.test" },
            { url: "https://3.test" },
          ],
          truncated: false,
        }),
      }),
    );
    const result = await runtime.search({ query: "x", maxResults: 2 });
    expect(result.sources).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("rejects duplicate provider ids", () => {
    const runtime = createWebRuntime();
    runtime.registerFetchProvider(createFakeFetchProvider({ id: "http" }));
    expect(() =>
      runtime.registerFetchProvider(createFakeFetchProvider({ id: "http" })),
    ).toThrow(WebError);
  });

  it("errors when no fetch provider is available", async () => {
    const runtime = createWebRuntime();
    await expect(
      runtime.fetch({ url: "https://example.com" }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});
