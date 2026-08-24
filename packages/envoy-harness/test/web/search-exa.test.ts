/**
 * Exa Search provider (hermetic, mocked fetch).
 */

import { describe, expect, it } from "vitest";

import { createExaSearchProvider } from "../../src/web/search-exa.js";

describe("createExaSearchProvider", () => {
  it("available() is true when env key is set", () => {
    const provider = createExaSearchProvider({
      env: { EXA_API_KEY: "test-key" },
    });
    expect(provider.id).toBe("exa");
    expect(provider.available()).toBe(true);
  });

  it("available() is false without env or listed credentials", () => {
    const provider = createExaSearchProvider({
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
    const dir = await mkdtemp(path.join(tmpdir(), "exa-"));
    const filePath = path.join(dir, "creds.json");
    await writeFile(
      filePath,
      JSON.stringify({ EXA_API_KEY: "from-file" }),
    );
    if (process.platform !== "win32") await chmod(filePath, 0o600);
    const file = createFileCredentialsProvider({
      filePath,
      skipPermissionCheck: process.platform === "win32",
    });
    await file.resolve(
      { name: "EXA_API_KEY", source: "file" },
      { signal: AbortSignal.timeout(5_000) },
    );
    const provider = createExaSearchProvider({
      env: {},
      credentials: file,
    });
    expect(provider.available()).toBe(true);
  });

  it("search() maps Exa JSON via mocked fetch", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Example",
              url: "https://example.com",
              text: "A snippet",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const provider = createExaSearchProvider({
      env: { EXA_API_KEY: "secret" },
      fetchImpl,
    });
    const result = await provider.search(
      { query: "envoy", maxResults: 5 },
      new AbortController().signal,
    );
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.url).toBe("https://example.com");
    expect(result.sources[0]?.title).toBe("Example");
    expect(result.sources[0]?.snippet).toBe("A snippet");
  });
});
