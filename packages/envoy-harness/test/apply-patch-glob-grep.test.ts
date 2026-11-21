/**
 * Wave 2 — apply_patch, glob, grep, spill.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  InMemorySession,
  applyPatchTool,
  createSpillStore,
  makeGlobTool,
  makeGrepTool,
  newSessionId,
  type ToolContext,
} from "../src/index.js";

async function tmpCtx(): Promise<{ ctx: ToolContext; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-fs-"));
  const ctx: ToolContext = {
    cwd: dir,
    session: new InMemorySession(newSessionId(), {
      cwd: dir,
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    }),
    abortSignal: new AbortController().signal,
    sandboxPolicy: {
      mode: "workspace-write",
      approval: "on-request",
      backend: "none",
      writableRoots: [dir],
      networkAccess: false,
      slashTmpWritable: true,
    },
  };
  return { ctx, dir };
}

describe("apply_patch", () => {
  it("applies an Update File hunk", async () => {
    const { ctx, dir } = await tmpCtx();
    await fs.writeFile(path.join(dir, "a.ts"), "const x = 1;\nconst y = 2;\n", "utf8");
    const res = await applyPatchTool.execute(
      {
        patch: `*** Begin Patch
*** Update File: a.ts
 const x = 1;
-const y = 2;
+const y = 3;
*** End Patch`,
      },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const text = await fs.readFile(path.join(dir, "a.ts"), "utf8");
    expect(text).toContain("const y = 3;");
  });

  it("fuzzy-matches whitespace-normalized context", async () => {
    const { ctx, dir } = await tmpCtx();
    await fs.writeFile(
      path.join(dir, "b.ts"),
      "function  hello() {\n  return 1;\n}\n",
      "utf8",
    );
    const res = await applyPatchTool.execute(
      {
        patch: `*** Begin Patch
*** Update File: b.ts
 function hello() {
-  return 1;
+  return 2;
 }
*** End Patch`,
      },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const text = await fs.readFile(path.join(dir, "b.ts"), "utf8");
    expect(text).toContain("return 2;");
  });
});

describe("glob + grep + spill", () => {
  it("glob finds files", async () => {
    const { ctx, dir } = await tmpCtx();
    await fs.writeFile(path.join(dir, "one.ts"), "a", "utf8");
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "sub", "two.ts"), "b", "utf8");
    const glob = makeGlobTool();
    const res = await glob.execute({ pattern: "**/*.ts" }, ctx);
    const parsed = JSON.parse(String(res.content)) as { paths: string[] };
    expect(parsed.paths).toEqual(
      expect.arrayContaining(["one.ts", "sub/two.ts"]),
    );
  });

  it("grep finds lines and can spill", async () => {
    const { ctx, dir } = await tmpCtx();
    await fs.writeFile(
      path.join(dir, "c.ts"),
      "alpha\nfindme here\nbeta\n",
      "utf8",
    );
    const spill = createSpillStore({
      root: path.join(dir, ".spill"),
      maxInlineChars: 10,
    });
    const grep = makeGrepTool({ spill, maxMatches: 1 });
    const res = await grep.execute({ pattern: "findme" }, ctx);
    const parsed = JSON.parse(String(res.content)) as {
      hits: string[];
      ok: boolean;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.hits[0]).toMatch(/findme/);
  });
});
