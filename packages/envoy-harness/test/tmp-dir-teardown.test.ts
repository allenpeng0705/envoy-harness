/**
 * The temp-directory teardown backstop.
 *
 * **Why this has its own test.** `removeTempDir` exists because a
 * session's atomic rewrite creates `<file>.rewrite-<pid>.tmp` mid-flight,
 * and a `rm -rf` that walks the directory in that window fails with
 * `ENOTEMPTY` — a *teardown* throw that vitest reports as a failed test
 * whose body never failed. That produced a reproducible 1-in-8
 * full-suite flake (`PersistedSession.setTitle > mutates metadata.title in
 * place`), so the invariant is worth pinning: removing a session
 * directory must succeed even while a writer is still flushing into it.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { PersistedSession } from "../src/index.js";
import { removeTempDir } from "./support/tmp-dir.js";

async function makeDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "envoy-tmpdir-test-"));
}

describe("removeTempDir", () => {
  it("removes a directory whose session writer is still flushing", async () => {
    const dir = await makeDir();
    const session = await PersistedSession.create({
      id: "racy",
      metadata: {
        cwd: dir,
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      },
      filePath: path.join(dir, "racy.jsonl"),
    });
    // Enqueue work that the atomic rewrite path turns into a sibling
    // `.rewrite-<pid>.tmp`, then tear down WITHOUT closing: this is the
    // exact shape that used to throw.
    for (let i = 0; i < 20; i += 1) {
      session.appendMessage("user", [{ type: "text", text: `msg ${i}` }]);
    }
    session.setTitle("still writing");

    await expect(removeTempDir(dir)).resolves.toBeUndefined();
    // And it really is gone, not merely "did not throw".
    await expect(readdir(dir)).rejects.toThrow();
  });

  it("removes a plain directory", async () => {
    const dir = await makeDir();
    await expect(removeTempDir(dir)).resolves.toBeUndefined();
    await expect(readdir(dir)).rejects.toThrow();
  });

  it("is a no-op for a path that does not exist", async () => {
    const dir = await makeDir();
    await removeTempDir(dir);
    await expect(removeTempDir(dir)).resolves.toBeUndefined();
  });
});
