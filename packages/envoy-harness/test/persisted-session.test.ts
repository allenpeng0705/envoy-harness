/**
 * F14.1 — `PersistedSession` tests.
 *
 * The on-disk JSONL format is the contract between
 * `PersistedSession.create()` (writer) and
 * `PersistedSession.open()` (reader). The tests
 * below exercise the format, the in-memory ↔ disk
 * relationship, the sync `appendMessage` + fire-and-
 * forget disk write, and the `setTitle` rewrite.
 *
 * **Why these tests matter:** the format is the
 * durability layer. A regression in the writer
 * (wrong field names, bad escape) silently corrupts
 * the user's session file — the next `--resume`
 * fails with "invalid header" or, worse, returns a
 * half-loaded session. The tests pin the format.
 *
 * **Test isolation:** each test uses a fresh temp
 * dir (via `fs.mkdtemp`). No shared state between
 * tests. The fire-and-forget writes are awaited
 * before assertions where it matters (file
 * content checks).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { PersistedSession } from "../src/session/persisted-session.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-persisted-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function fileFor(id: string): string {
  return path.join(tmpDir, `${id}.jsonl`);
}

function makeMeta(overrides: Partial<{ cwd: string; title: string }> = {}) {
  return {
    cwd: overrides.cwd ?? "/tmp",
    title: overrides.title ?? "test session",
    permissionMode: "workspace-write" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("PersistedSession.create", () => {
  it("writes a header line and returns an empty session", async () => {
    const id = "test-create-1";
    const session = await PersistedSession.create({
      id,
      metadata: makeMeta(),
      filePath: fileFor(id),
    });
    expect(session.id).toBe(id);
    expect(session.messages).toHaveLength(0);

    const file = await readFile(fileFor(id), "utf-8");
    // Single header line; no messages yet.
    const lines = file.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const header = JSON.parse(lines[0]!);
    expect(header._kind).toBe("header");
    expect(header.id).toBe(id);
    expect(header.metadata.cwd).toBe("/tmp");
    expect(header.metadata.title).toBe("test session");
  });

  it("throws when the file already exists", async () => {
    const id = "test-create-collision";
    await PersistedSession.create({
      id,
      metadata: makeMeta(),
      filePath: fileFor(id),
    });
    await expect(
      PersistedSession.create({
        id,
        metadata: makeMeta(),
        filePath: fileFor(id),
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("creates the parent dir if it does not exist", async () => {
    const nested = path.join(tmpDir, "nested", "deeper");
    const id = "test-create-nested";
    const session = await PersistedSession.create({
      id,
      metadata: makeMeta(),
      filePath: path.join(nested, `${id}.jsonl`),
    });
    expect(session.id).toBe(id);
    const file = await readFile(path.join(nested, `${id}.jsonl`), "utf-8");
    expect(file).toContain(`"id":"${id}"`);
  });
});

describe("PersistedSession.open", () => {
  it("reads back the header + messages from a created session", async () => {
    const id = "test-open-1-second";
    // Create a session and append some messages.
    const written = await PersistedSession.create({
      id,
      metadata: makeMeta({ title: "my chat" }),
      filePath: fileFor(id),
    });
    written.appendMessage("user", [{ type: "text", text: "hi" }]);
    written.appendMessage("assistant", [{ type: "text", text: "hello" }]);
    // Wait for the fire-and-forget disk writes.
    await new Promise((r) => setTimeout(r, 50));
    // Re-open the same file and verify the format
    // round-trips.
    const reopened = await PersistedSession.open(fileFor(id));
    expect(reopened.id).toBe(id);
    expect(reopened.metadata.title).toBe("my chat");
    expect(reopened.messages).toHaveLength(2);
    expect(reopened.messages[0]?.role).toBe("user");
    expect(reopened.messages[1]?.role).toBe("assistant");
    // The text content round-trips through JSON.
    const firstText = (reopened.messages[0]?.content[0] as { type: "text"; text: string }).text;
    expect(firstText).toBe("hi");
  });

  it("throws on missing file", async () => {
    await expect(PersistedSession.open(fileFor("does-not-exist"))).rejects.toThrow(
      /file not found/,
    );
  });

  it("throws on empty file", async () => {
    const id = "test-open-empty";
    await writeFile(fileFor(id), "", "utf-8");
    await expect(PersistedSession.open(fileFor(id))).rejects.toThrow(/file is empty/);
  });

  it("throws on invalid header", async () => {
    const id = "test-open-bad-header";
    await writeFile(fileFor(id), "not a header line\n", "utf-8");
    await expect(PersistedSession.open(fileFor(id))).rejects.toThrow(/invalid header/);
  });

  it("throws on header missing _kind sentinel", async () => {
    const id = "test-open-bad-kind";
    await writeFile(fileFor(id), JSON.stringify({ id, metadata: {} }) + "\n", "utf-8");
    await expect(PersistedSession.open(fileFor(id))).rejects.toThrow(/invalid header/);
  });

  it("throws on a malformed message line", async () => {
    const id = "test-open-bad-msg";
    const header = JSON.stringify({
      _kind: "header",
      id,
      metadata: makeMeta(),
    });
    await writeFile(
      fileFor(id),
      header + "\n" + JSON.stringify({ role: "user" }) + "\n", // no content
      "utf-8",
    );
    await expect(PersistedSession.open(fileFor(id))).rejects.toThrow(/invalid message/);
  });
});

describe("PersistedSession.appendMessage", () => {
  it("appends the message to the in-memory list synchronously", async () => {
    const id = "test-append-1";
    const session = await PersistedSession.create({
      id,
      metadata: makeMeta(),
      filePath: fileFor(id),
    });
    // Sync: returns the new length immediately.
    const len = session.appendMessage("user", [{ type: "text", text: "hi" }]);
    expect(len).toBe(1);
    expect(session.messages).toHaveLength(1);
  });

  it("writes the message to disk (eventually)", async () => {
    const id = "test-append-2";
    const session = await PersistedSession.create({
      id,
      metadata: makeMeta(),
      filePath: fileFor(id),
    });
    session.appendMessage("user", [{ type: "text", text: "hi" }]);
    session.appendMessage("assistant", [{ type: "text", text: "hello" }]);
    // The disk write is fire-and-forget. Give it a
    // couple of microtask ticks to flush.
    await new Promise((r) => setTimeout(r, 50));
    const file = await readFile(fileFor(id), "utf-8");
    const lines = file.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3); // header + 2 messages
    // The header is line 1; messages are 2 and 3.
    const msg1 = JSON.parse(lines[1]!);
    expect(msg1.role).toBe("user");
    const msg2 = JSON.parse(lines[2]!);
    expect(msg2.role).toBe("assistant");
  });
});

describe("PersistedSession.setTitle", () => {
  it("mutates metadata.title in place", async () => {
    const id = "test-title-1";
    const session = await PersistedSession.create({
      id,
      metadata: makeMeta({ title: "old" }),
      filePath: fileFor(id),
    });
    session.setTitle("new title");
    expect(session.metadata.title).toBe("new title");
  });

  it("rewrites the header on disk so /resume sees the new title", async () => {
    const id = "test-title-2";
    await PersistedSession.create({
      id,
      metadata: makeMeta({ title: "old" }),
      filePath: fileFor(id),
    });
    // Re-open and rename.
    const session = await PersistedSession.open(fileFor(id));
    session.setTitle("new title");
    // Wait for the fire-and-forget rewrite.
    await new Promise((r) => setTimeout(r, 50));
    const file = await readFile(fileFor(id), "utf-8");
    const lines = file.split("\n").filter((l) => l.length > 0);
    // The header is line 1; the rewrite preserves the
    // single-line header + the (empty) message list.
    expect(lines).toHaveLength(1);
    const header = JSON.parse(lines[0]!);
    expect(header.metadata.title).toBe("new title");
  });

  it("preserves the existing message list when rewriting the header", async () => {
    const id = "test-title-3";
    const session = await PersistedSession.create({
      id,
      metadata: makeMeta({ title: "old" }),
      filePath: fileFor(id),
    });
    session.appendMessage("user", [{ type: "text", text: "hi" }]);
    await new Promise((r) => setTimeout(r, 50));
    session.setTitle("new title");
    await new Promise((r) => setTimeout(r, 50));
    const file = await readFile(fileFor(id), "utf-8");
    const lines = file.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2); // header + 1 message
    const msg = JSON.parse(lines[1]!);
    expect(msg.role).toBe("user");
  });
});
