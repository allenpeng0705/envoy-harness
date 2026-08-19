/**
 * F14.1 — `SessionStore` tests.
 *
 * The store is the directory-aware wrapper around
 * `PersistedSession`. It owns the file layout
 * (`<id>.jsonl` in `dir`), the listing order (most
 * recently modified first), and the existence /
 * delete primitives.
 *
 * **Why these tests matter:** the store is the
 * bridge between the CLI runner (`--resume`,
 * `--fork`, `--persist`) and the on-disk format.
 * A regression in the listing order breaks the
 * "most recent session first" UX; a regression in
 * the file path builder breaks `--resume` entirely
 * (the loaded id is different from the saved one).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { PersistedSession } from "../src/session/persisted-session.js";
import { SessionStore } from "../src/session/session-store.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-store-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeMeta(title = "test") {
  return {
    cwd: "/tmp",
    title,
    permissionMode: "workspace-write" as const,
    startedAt: new Date().toISOString(),
  };
}

describe("SessionStore.create", () => {
  it("creates a new session with a fresh id and the file on disk", async () => {
    const store = new SessionStore({ dir: tmpDir });
    const session = await store.create(makeMeta());
    expect(session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // The file exists.
    const exists = await store.exists(session.id);
    expect(exists).toBe(true);
  });

  it("two consecutive creates have different ids", async () => {
    const store = new SessionStore({ dir: tmpDir });
    const a = await store.create(makeMeta());
    const b = await store.create(makeMeta());
    expect(a.id).not.toBe(b.id);
  });
});

describe("SessionStore.createWithId", () => {
  it("creates a session with the specified id (for --fork)", async () => {
    const store = new SessionStore({ dir: tmpDir });
    const session = await store.createWithId("forked-id", makeMeta());
    expect(session.id).toBe("forked-id");
    const exists = await store.exists("forked-id");
    expect(exists).toBe(true);
  });
});

describe("SessionStore.load", () => {
  it("loads an existing session from disk", async () => {
    const store = new SessionStore({ dir: tmpDir });
    const written = await store.create(makeMeta("loaded title"));
    written.appendMessage("user", [{ type: "text", text: "hi" }]);
    // Wait for the fire-and-forget disk write.
    await new Promise((r) => setTimeout(r, 50));
    const loaded = await store.load(written.id);
    expect(loaded.id).toBe(written.id);
    expect(loaded.metadata.title).toBe("loaded title");
    expect(loaded.messages).toHaveLength(1);
  });

  it("throws on a missing session", async () => {
    const store = new SessionStore({ dir: tmpDir });
    await expect(store.load("does-not-exist")).rejects.toThrow();
  });
});

describe("SessionStore.exists", () => {
  it("returns true for a known session", async () => {
    const store = new SessionStore({ dir: tmpDir });
    const session = await store.create(makeMeta());
    expect(await store.exists(session.id)).toBe(true);
  });

  it("returns false for a missing session", async () => {
    const store = new SessionStore({ dir: tmpDir });
    expect(await store.exists("nope")).toBe(false);
  });
});

describe("SessionStore.list", () => {
  it("returns an empty array when the dir does not exist", async () => {
    const store = new SessionStore({ dir: path.join(tmpDir, "missing") });
    const ids = await store.list();
    expect(ids).toEqual([]);
  });

  it("returns ids sorted by mtime, most recent first", async () => {
    const store = new SessionStore({ dir: tmpDir });
    // Create 3 sessions, with explicit mtimes in
    // increasing order. We have to backdate the
    // mtime so the sort is deterministic (the
    // `create` call is fast; without backdating,
    // the order would depend on clock resolution).
    const a = await store.create(makeMeta());
    const b = await store.create(makeMeta());
    const c = await store.create(makeMeta());
    const now = Date.now() / 1000;
    // a: oldest, c: newest
    await utimes(path.join(tmpDir, `${a.id}.jsonl`), now - 200, now - 200);
    await utimes(path.join(tmpDir, `${b.id}.jsonl`), now - 100, now - 100);
    await utimes(path.join(tmpDir, `${c.id}.jsonl`), now, now);
    const ids = await store.list();
    expect(ids).toEqual([c.id, b.id, a.id]);
  });

  it("ignores non-jsonl files in the dir", async () => {
    const store = new SessionStore({ dir: tmpDir });
    const session = await store.create(makeMeta());
    // A stray file in the dir should not be listed.
    await writeFile(path.join(tmpDir, "stray.txt"), "noise", "utf-8");
    const ids = await store.list();
    expect(ids).toEqual([session.id]);
  });
});

describe("SessionStore.delete", () => {
  it("deletes a session by id and returns true", async () => {
    const store = new SessionStore({ dir: tmpDir });
    const session = await store.create(makeMeta());
    const deleted = await store.delete(session.id);
    expect(deleted).toBe(true);
    expect(await store.exists(session.id)).toBe(false);
  });

  it("returns false for a missing session", async () => {
    const store = new SessionStore({ dir: tmpDir });
    const deleted = await store.delete("nope");
    expect(deleted).toBe(false);
  });
});

describe("SessionStore + PersistedSession integration", () => {
  it("a session created via the store round-trips through load", async () => {
    const store = new SessionStore({ dir: tmpDir });
    const written = await store.create(makeMeta("round trip"));
    // Append a few messages; the fire-and-forget
    // disk writes need a tick to flush before the
    // reload sees them.
    written.appendMessage("user", [{ type: "text", text: "hi" }]);
    written.appendMessage("assistant", [{ type: "text", text: "hello" }]);
    await new Promise((r) => setTimeout(r, 50));
    const loaded = await store.load(written.id);
    expect(loaded.id).toBe(written.id);
    expect(loaded.metadata.title).toBe("round trip");
    expect(loaded.messages).toHaveLength(2);
  });

  it("PersistedSession.open and SessionStore.load are equivalent", async () => {
    const store = new SessionStore({ dir: tmpDir });
    const session = await store.create(makeMeta());
    const fromStore = await store.load(session.id);
    const fromPersisted = await PersistedSession.open(
      path.join(tmpDir, `${session.id}.jsonl`),
    );
    expect(fromStore.id).toBe(fromPersisted.id);
    expect(fromStore.metadata).toEqual(fromPersisted.metadata);
  });
});
