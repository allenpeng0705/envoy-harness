/**
 * Phase C — Brave Search provider (hermetic, mocked fetch).
 */

import { describe, expect, it } from "vitest";

import { createBraveSearchProvider } from "../../src/web/search-brave.js";

describe("createBraveSearchProvider", () => {
  it("available() is true when env key is set", () => {
    const provider = createBraveSearchProvider({
      env: { BRAVE_SEARCH_API_KEY: "test-key" },
    });
    expect(provider.id).toBe("brave");
    expect(provider.available()).toBe(true);
  });

  it("available() is false without env or listed credentials", () => {
    const provider = createBraveSearchProvider({
      env: {},
    });
    expect(provider.available()).toBe(false);
  });

  it("available() is true when file credentials already list the key", async () => {
    const { mkdtemp, writeFile, chmod } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { createFileCredentialsProvider } = await import(
      "../../src/credentials/index.js"
    );
    const dir = await mkdtemp(path.join(tmpdir(), "brave-"));
    const filePath = path.join(dir, "creds.json");
    await writeFile(
      filePath,
      JSON.stringify({ BRAVE_SEARCH_API_KEY: "from-file" }),
    );
    if (process.platform !== "win32") await chmod(filePath, 0o600);
    const file = createFileCredentialsProvider({
      filePath,
      skipPermissionCheck: process.platform === "win32",
    });
    // Prime the file cache so list() advertises the key.
    await file.resolve(
      { name: "BRAVE_SEARCH_API_KEY", source: "file" },
      { signal: AbortSignal.timeout(5_000) },
    );
    const provider = createBraveSearchProvider({
      env: {},
      credentials: file,
    });
    expect(provider.available()).toBe(true);
  });

  it("search() maps Brave JSON via mocked fetch", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Example",
                url: "https://example.com",
                description: "A snippet",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const provider = createBraveSearchProvider({
      env: { BRAVE_SEARCH_API_KEY: "secret" },
      fetchImpl,
    });
    const result = await provider.search({ query: "envoy", maxResults: 5 });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.url).toBe("https://example.com");
    expect(result.sources[0]?.title).toBe("Example");
    expect(result.sources[0]?.snippet).toBe("A snippet");
  });

  it("search() fails when HTTP status is not ok", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 401 });
    const provider = createBraveSearchProvider({
      env: { BRAVE_SEARCH_API_KEY: "secret" },
      fetchImpl,
    });
    await expect(provider.search({ query: "x" })).rejects.toMatchObject({
      code: "FETCH_FAILED",
    });
  });
});
