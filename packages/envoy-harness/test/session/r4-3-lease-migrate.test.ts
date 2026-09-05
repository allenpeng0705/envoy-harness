/**
 * R4.3 — write lease + session format migration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { PersistedSession } from "../../src/session/persisted-session.js";
import { migrateSessionFile } from "../../src/session/migrate.js";
import {
  SessionFileBusyError,
  acquireSessionWriteLease,
  resetWriteLeaseProvider,
} from "../../src/session/write-lease.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-r43-"));
  resetWriteLeaseProvider();
});

afterEach(async () => {
  resetWriteLeaseProvider();
  await rm(tmpDir, { recursive: true, force: true });
});

function meta() {
  return {
    cwd: tmpDir,
    startedAt: new Date().toISOString(),
    permissionMode: "workspace-write" as const,
  };
}

describe("session write lease", () => {
  it("create acquires lease; close releases; reopen works", async () => {
    const filePath = path.join(tmpDir, "s1.jsonl");
    const session = await PersistedSession.create({
      id: "s1",
      metadata: meta(),
      filePath,
    });
    await session.close();
    const again = await PersistedSession.open(filePath);
    expect(again.id).toBe("s1");
    await again.close();
  });

  it("contended open fails clearly when lock file held by live pid", async () => {
    const filePath = path.join(tmpDir, "busy.jsonl");
    await writeFile(filePath, "{}\n", "utf-8");
    const lockPath = `${filePath}.lock`;
    // Simulate another process: lock file with this pid, but not via our Map.
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    await expect(acquireSessionWriteLease(filePath)).rejects.toBeInstanceOf(
      SessionFileBusyError,
    );
    await expect(acquireSessionWriteLease(filePath)).rejects.toThrow(
      /locked by another process/,
    );
  });

  it("openReadOnly works while write lease held", async () => {
    const filePath = path.join(tmpDir, "ro.jsonl");
    const writer = await PersistedSession.create({
      id: "ro",
      metadata: meta(),
      filePath,
    });
    writer.appendMessage("user", [{ type: "text", text: "hi" }]);
    await writer.flush();
    const reader = await PersistedSession.openReadOnly(filePath);
    expect(reader.messages).toHaveLength(1);
    await writer.close();
  });

  it("stale lock from dead pid is cleared", async () => {
    const filePath = path.join(tmpDir, "x.jsonl");
    await writeFile(filePath, "{}\n", "utf-8");
    const lockPath = `${filePath}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 2_147_483_646,
        acquiredAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    const lease = await acquireSessionWriteLease(filePath);
    await lease.release();
  });
});

describe("migrateSessionFile v1→v2", () => {
  it("migrates v1 fixture without silent rewrite on open", async () => {
    const filePath = path.join(tmpDir, "v1.jsonl");
    const header = {
      _kind: "header",
      id: "fix-v1",
      metadata: meta(),
      formatVersion: 1,
    };
    const msg = { role: "user", content: [{ type: "text", text: "hi" }] };
    await writeFile(
      filePath,
      JSON.stringify(header) + "\n" + JSON.stringify(msg) + "\n",
      "utf-8",
    );

    const before = await readFile(filePath, "utf-8");
    const opened = await PersistedSession.openReadOnly(filePath);
    expect(opened.messages).toHaveLength(1);
    const afterOpen = await readFile(filePath, "utf-8");
    expect(afterOpen).toBe(before);

    const result = await migrateSessionFile(filePath);
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(2);
    expect(result.generation).toBe(1);

    const lines = (await readFile(filePath, "utf-8"))
      .split("\n")
      .filter((l) => l.length > 0);
    const next = JSON.parse(lines[0]!);
    expect(next.formatVersion).toBe(2);
    expect(next.generation).toBe(1);
    expect(next.migratedFrom).toEqual({ formatVersion: 1 });
    expect(lines[1]).toBe(JSON.stringify(msg));

    await expect(migrateSessionFile(filePath)).rejects.toThrow(/already format/);
  });

  it("migrates legacy file without formatVersion", async () => {
    const filePath = path.join(tmpDir, "legacy.jsonl");
    const header = { _kind: "header", id: "leg", metadata: meta() };
    await writeFile(filePath, JSON.stringify(header) + "\n", "utf-8");
    const result = await migrateSessionFile(filePath, { backup: false });
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(2);
  });
});
