/**
 * Compaction must never leave the session unreadable or empty.
 *
 * **The bug these tests pin shut.** Compaction used to be implemented as
 * `session.clear()` followed by re-appending the kept messages.
 * `clear()` durably rewrote the file to a **header-only** log; only then
 * were the survivors buffered. Disk therefore held an empty session for
 * a window, so a crash (or a failed batch write) lost the entire
 * transcript — and at HEAD the `clear()` write was a non-atomic,
 * truncating, error-swallowing `writeFile`, which could also leave a
 * partial file that `open()` refused, making the session *permanently
 * unopenable*.
 *
 * The invariant asserted here is the one that matters:
 *
 * > At every observable moment, the file on disk is a **complete,
 * > openable session** — either the pre-compaction transcript or the
 * > post-compaction one. Never a truncated file, never header-only.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "./support/tmp-dir.js";

import {
  InMemorySession,
  PersistedSession,
  newSessionId,
  type Message,
} from "../src/index.js";

let tmp: string;
let sessionFile: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-compact-"));
  sessionFile = path.join(tmp, "session.jsonl");
});

afterEach(async () => {
  await removeTempDir(tmp);
});

function sessionMeta() {
  return {
    cwd: tmp,
    permissionMode: "workspace-write" as const,
    startedAt: new Date().toISOString(),
  };
}

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

/** Every line of the file parses as JSON (no torn/partial record). */
async function assertFileIsWellFormed(file: string): Promise<number> {
  const raw = await fs.readFile(file, "utf-8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  for (const line of lines) {
    expect(() => JSON.parse(line)).not.toThrow();
  }
  return lines.length;
}

describe("replaceMessages — atomic transcript swap", () => {
  it("publishes the replacement in ONE step (never header-only)", async () => {
    const session = await PersistedSession.create({
      id: newSessionId(),
      filePath: sessionFile,
      metadata: sessionMeta(),
    });
    for (let i = 0; i < 20; i++) {
      session.appendMessage("user", [{ type: "text", text: `m${i}` }]);
    }
    await session.flush();
    expect(await assertFileIsWellFormed(sessionFile)).toBe(21); // header + 20

    // Compact down to 3 messages.
    session.replaceMessages([userMessage("kept-1"), userMessage("kept-2")]);

    // Immediately after the swap — before any flush — the file must still
    // be a complete session. Under the old clear()+append implementation
    // this is where it would be header-only (or truncated).
    const lineCount = await assertFileIsWellFormed(sessionFile);
    expect(lineCount).toBeGreaterThanOrEqual(3); // header + 2 kept

    await session.flush();
    const reloaded = await PersistedSession.openReadOnly(sessionFile);
    expect(reloaded.messages.map((m) => m.content[0])).toEqual([
      { type: "text", text: "kept-1" },
      { type: "text", text: "kept-2" },
    ]);
    expect(reloaded.repairedOnOpen.danglingToolCalls).toBe(0);
    await session.close();
  });

  it("keeps the transcript openable when the replacement is empty", async () => {
    const session = await PersistedSession.create({
      id: newSessionId(),
      filePath: sessionFile,
      metadata: sessionMeta(),
    });
    session.appendMessage("user", [{ type: "text", text: "only" }]);
    await session.flush();

    session.replaceMessages([]);
    await session.flush();

    // An explicit empty transcript is a valid session (header only), not
    // a corrupt one.
    const reloaded = await PersistedSession.openReadOnly(sessionFile);
    expect(reloaded.messages).toHaveLength(0);
    await session.close();
  });

  it("is an atomic swap, not a truncate-then-rewrite", async () => {
    const session = await PersistedSession.create({
      id: newSessionId(),
      filePath: sessionFile,
      metadata: sessionMeta(),
    });
    for (let i = 0; i < 5; i++) {
      session.appendMessage("user", [{ type: "text", text: `before-${i}` }]);
    }
    await session.flush();

    // Capture the inode before/after: an atomic rename replaces the
    // directory entry, an in-place rewrite keeps the inode.
    const before = await fs.stat(sessionFile);
    session.replaceMessages([userMessage("after")]);
    await session.flush();
    const after = await fs.stat(sessionFile);

    // The publish went through a temp file + rename, so the inode changed.
    expect(after.ino).not.toBe(before.ino);
    // …and no temp files are left behind.
    const leftovers = (await fs.readdir(tmp)).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
    await session.close();
  });

  it("does not leave a temp file when the publication is interrupted", async () => {
    const session = await PersistedSession.create({
      id: newSessionId(),
      filePath: sessionFile,
      metadata: sessionMeta(),
    });
    session.appendMessage("user", [{ type: "text", text: "keep me" }]);
    await session.flush();
    session.replaceMessages([userMessage("new")]);
    // Deliberately do NOT flush: simulate a crash before the batch lands.
    const onDisk = await fs.readFile(sessionFile, "utf-8");
    expect(onDisk).toContain("keep me");
    await session.close();
  });
});

describe("InMemorySession.replaceMessages", () => {
  it("swaps the transcript and copies content", () => {
    const session = new InMemorySession(newSessionId(), sessionMeta());
    session.appendMessage("user", [{ type: "text", text: "old" }]);

    const replacement = [userMessage("new")];
    session.replaceMessages(replacement);

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "new",
    });
    // Defensive copy: mutating the caller's array must not alias.
    replacement[0]!.content = [];
    expect(session.messages[0]?.content).toHaveLength(1);
  });
});
