/**
 * Session write-lease lifecycle for session owners.
 *
 * **The leak these lock down.** `PersistedSession` holds an exclusive
 * sidecar lock (`<file>.jsonl.lock`) for as long as it is open. `flush()`
 * makes the transcript durable but keeps the lock; only `close()` releases
 * it. The CLI's REPL and one-shot paths used to flush and never close, so
 * a finished session left its lock file on disk — and a *second* process
 * asking for the same session got `SessionFileBusyError` until the
 * stale-PID heuristic happened to reclaim it.
 *
 * Within one process the lease is reference-counted, so a same-process
 * "load again" cannot detect the leak. These tests assert on the lock file
 * itself, which is the honest observable: after the owner is done, it must
 * be gone.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "./support/tmp-dir.js";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { SessionStore, runRepl } from "../src/index.js";
import {
  StringWritable,
  fakeLineReader,
  makeArgs,
  scriptedModel,
  textBlock,
} from "./helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-lease-"));
});

afterEach(async () => {
  await removeTempDir(tmpDir);
});

function lockPathFor(id: string): string {
  return path.join(tmpDir, `${id}.jsonl.lock`);
}

async function seed(id = "seeded"): Promise<string> {
  const store = new SessionStore({ dir: tmpDir });
  const session = await store.createWithId(id, {
    cwd: tmpDir,
    permissionMode: "read-only",
    startedAt: new Date().toISOString(),
    title: "seed",
  });
  session.appendMessage("user", [{ type: "text", text: "prior" }]);
  // Release the seed's own lease so the test measures only the REPL's.
  await session.close();
  return id;
}

describe("Session.close()", () => {
  it("exists on the in-memory session and is a no-op", async () => {
    const store = new SessionStore({ dir: tmpDir });
    const session = await store.createWithId("mem", {
      cwd: tmpDir,
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    await expect(session.close?.()).resolves.toBeUndefined();
  });

  it("releases the lock file", async () => {
    const store = new SessionStore({ dir: tmpDir });
    const session = await store.createWithId("release", {
      cwd: tmpDir,
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    // Negative control: an OPEN session does hold the lock, so the
    // post-close assertion below is not vacuous.
    expect(existsSync(lockPathFor("release"))).toBe(true);
    await session.close();
    expect(existsSync(lockPathFor("release"))).toBe(false);
  });

  it("is idempotent", async () => {
    const store = new SessionStore({ dir: tmpDir });
    const session = await store.createWithId("twice", {
      cwd: tmpDir,
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    });
    await session.close();
    await expect(session.close()).resolves.toBeUndefined();
    expect(existsSync(lockPathFor("twice"))).toBe(false);
  });
});

describe("runRepl releases the session lease", () => {
  it("after a normal --resume run", async () => {
    const id = await seed("repl-normal");
    // The seed released its own lease, so any lock present afterwards
    // belongs to the REPL.
    expect(existsSync(lockPathFor(id))).toBe(false);

    await runRepl({
      model: scriptedModel([{ content: [textBlock("done")] }]),
      args: makeArgs(),
      lineReader: fakeLineReader(["/quit"]),
      sessionStore: new SessionStore({ dir: tmpDir }),
      resumeFromId: id,
      stdout: new StringWritable(),
      stderr: new StringWritable(),
      historyPath: "",
    });

    expect(existsSync(lockPathFor(id))).toBe(false);
  });

  it("after a startup failure (malformed config)", async () => {
    const id = await seed("repl-fail");
    const badConfig = path.join(tmpDir, "broken.toml");
    await writeFile(badConfig, "this is : not = valid toml [[[", "utf8");

    await expect(
      runRepl({
        model: scriptedModel([{ content: [textBlock("never")] }]),
        args: makeArgs({ config: badConfig }),
        lineReader: fakeLineReader(["/quit"]),
        sessionStore: new SessionStore({ dir: tmpDir }),
        resumeFromId: id,
        stdout: new StringWritable(),
        stderr: new StringWritable(),
        historyPath: "",
      }),
    ).rejects.toThrow();

    // The loop's `finally` never ran, so this only holds because the
    // startup path releases explicitly.
    expect(existsSync(lockPathFor(id))).toBe(false);
  });
});
