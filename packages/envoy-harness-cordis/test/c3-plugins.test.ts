/**
 * C3 tests — host `credentials-local` + `web-search-exa` on the container.
 *
 * - credentials-local: file-backed credential document resolves through
 *   `ctx.credentials` (no network, hermetic).
 * - web-search-exa: registers its search provider on `ctx.web` (no network
 *   call; a real search would need an Exa API key).
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { createCordisContainer } from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cordis-c3-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("credentials-local", () => {
  it("resolves a credential from the local document", async () => {
    const doc = path.join(tmpDir, ".credentials.yaml");
    await fs.writeFile(doc, "EXA_API_KEY: sk-test-123\n");
    // The provider refuses documents readable beyond their owner.
    await fs.chmod(doc, 0o600);

    const container = await createCordisContainer({
      plugins: [
        {
          name: "credentials-local",
          config: { path: doc, watch: false },
        },
      ],
    });

    expect(container.status()[0]).toMatchObject({
      name: "credentials-local",
      state: "applied",
    });

    const resolved = await container.ctx.credentials.resolve(
      credentialRef("EXA_API_KEY"),
    );
    expect(resolved?.value).toBe("sk-test-123");

    await container.dispose();
  });
});

describe("web-search-exa", () => {
  it("registers its provider on ctx.web", async () => {
    const container = await createCordisContainer({
      plugins: [
        {
          name: "web-search-exa",
          config: { apiKey: "sk-test-123" },
        },
      ],
    });

    expect(container.status()[0]).toMatchObject({
      name: "web-search-exa",
      state: "applied",
    });

    // The provider registers itself on the web runtime during apply (a
    // duplicate would throw WEB_DUPLICATE_PROVIDER), so `applied` + a
    // runnable search surface proves registration — without a network call.
    expect(typeof container.ctx.web.search).toBe("function");
    expect(typeof container.ctx.web.fetch).toBe("function");

    await container.dispose();
  });
});
