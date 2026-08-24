/**
 * Perplexity Sonar search provider (hermetic, mocked fetch).
 */

import { describe, expect, it } from "vitest";

import { createPerplexitySearchProvider } from "../../src/web/search-perplexity.js";

describe("createPerplexitySearchProvider", () => {
  it("available() is true when env key is set", () => {
    const provider = createPerplexitySearchProvider({
      env: { PERPLEXITY_API_KEY: "test-key" },
    });
    expect(provider.id).toBe("perplexity");
    expect(provider.available()).toBe(true);
  });

  it("available() is false without env or listed credentials", () => {
    const provider = createPerplexitySearchProvider({
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
    const dir = await mkdtemp(path.join(tmpdir(), "pplx-"));
    const filePath = path.join(dir, "creds.json");
    await writeFile(
      filePath,
      JSON.stringify({ PERPLEXITY_API_KEY: "from-file" }),
    );
    if (process.platform !== "win32") await chmod(filePath, 0o600);
    const file = createFileCredentialsProvider({
      filePath,
      skipPermissionCheck: process.platform === "win32",
    });
    await file.resolve(
      { name: "PERPLEXITY_API_KEY", source: "file" },
      { signal: AbortSignal.timeout(5_000) },
    );
    const provider = createPerplexitySearchProvider({
      env: {},
      credentials: file,
    });
    expect(provider.available()).toBe(true);
  });

  it("search() maps citations and summary via mocked fetch", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          citations: [
            { title: "Source", url: "https://example.com/doc" },
          ],
          choices: [{ message: { content: "Summary text" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const provider = createPerplexitySearchProvider({
      env: { PERPLEXITY_API_KEY: "secret" },
      fetchImpl,
    });
    const result = await provider.search(
      { query: "envoy mesh", maxResults: 3 },
      new AbortController().signal,
    );
    expect(result.content).toBe("Summary text");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.url).toBe("https://example.com/doc");
    expect(result.sources[0]?.title).toBe("Source");
  });
});
