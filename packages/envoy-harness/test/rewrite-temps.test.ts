/**
 * Orphaned rewrite-temp reaping.
 *
 * `DurableLineWriter.rewrite()` publishes atomically through
 * `<file>.rewrite-<pid>.tmp`. A process that dies between the write and
 * the rename leaves that temp behind forever, so they accumulate one per
 * crash. The session file is never at risk — this is litter.
 *
 * **What these tests are really pinning is the blast radius.** The code
 * deletes files, so the negatives matter more than the positive: it must
 * not touch another session's temp, an unrelated file, a live writer's
 * temp, or a fresh one. Each of those has its own test.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_REAP_MIN_AGE_MS,
  PersistedSession,
  reapStaleRewriteTemps,
  rewriteTempPath,
  rewriteTempPid,
} from "../src/index.js";
import { removeTempDir } from "./support/tmp-dir.js";

const SESSION = "/sessions/abc.jsonl";

/** A pid that is certainly not running. */
const DEAD_PID = 999_999;

async function makeDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "envoy-reap-"));
}

/** Create `name` in `dir` with an mtime far enough in the past. */
async function makeOldFile(
  dir: string,
  name: string,
  ageMs = 10 * 60_000,
): Promise<string> {
  const full = path.join(dir, name);
  await writeFile(full, "stale");
  const when = new Date(Date.now() - ageMs);
  await utimes(full, when, when);
  return full;
}

async function listNames(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

describe("rewriteTempPath / rewriteTempPid", () => {
  it("round-trips the writer pid", () => {
    const p = rewriteTempPath(SESSION, 4321);
    expect(p).toBe("/sessions/abc.jsonl.rewrite-4321.tmp");
    expect(rewriteTempPid(SESSION, path.basename(p))).toBe(4321);
  });

  it("rejects anything that is not exactly our temp", () => {
    const rejected = [
      "abc.jsonl", // the session itself
      "abc.jsonl.lock", // the lease sidecar
      "other.jsonl.rewrite-1.tmp", // another session
      "abc.jsonl.rewrite-abc.tmp", // non-numeric pid
      "abc.jsonl.rewrite-.tmp", // empty pid
      "abc.jsonl.rewrite-1.tmp.bak", // extra suffix
      "abc.jsonl.rewrite-1", // missing .tmp
      "abc.jsonl.rewrite--1.tmp", // negative
      "xabc.jsonl.rewrite-1.tmp", // prefix, not exact basename
      // The adversarial one: contains `.rewrite-` and ends in `.tmp`, and
      // a prefix-agnostic parse (`slice(prefix.length, -4)`) would read its
      // bytes [17,19) as the pid "23" — deleting an unrelated file. Pinning
      // the EXACT basename is what prevents that.
      ".rewrite-aaaaaaaa123.tmp",
    ];
    for (const name of rejected) {
      expect(rewriteTempPid(SESSION, name), name).toBeUndefined();
    }
  });
});

describe("reapStaleRewriteTemps", () => {
  it("removes an orphan from a dead writer", async () => {
    const dir = await makeDir();
    try {
      const file = path.join(dir, "abc.jsonl");
      await writeFile(file, "{}\n");
      const orphan = await makeOldFile(dir, rewriteTempPath(file, DEAD_PID).split("/").pop()!);

      const result = await reapStaleRewriteTemps(file, { minAgeMs: 0 });
      expect(result.removed).toEqual([orphan]);
      expect(await listNames(dir)).toEqual(["abc.jsonl"]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("LEAVES a live writer's temp alone", async () => {
    const dir = await makeDir();
    try {
      const file = path.join(dir, "abc.jsonl");
      await writeFile(file, "{}\n");
      await makeOldFile(dir, rewriteTempPath(file, 4242).split("/").pop()!);

      const result = await reapStaleRewriteTemps(file, {
        minAgeMs: 0,
        isAlive: (pid) => pid === 4242,
      });
      expect(result.removed).toEqual([]);
      expect(result.skipped[0]?.reason).toContain("alive");
      expect(await listNames(dir)).toHaveLength(2);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("LEAVES a temp newer than the age floor (shared-filesystem guard)", async () => {
    const dir = await makeDir();
    try {
      const file = path.join(dir, "abc.jsonl");
      await writeFile(file, "{}\n");
      // Fresh: mtime is "now". A foreign host whose pid merely looks dead
      // locally could be writing this right now.
      const name = rewriteTempPath(file, DEAD_PID).split("/").pop()!;
      await writeFile(path.join(dir, name), "in flight");

      const result = await reapStaleRewriteTemps(file); // default floor
      expect(result.removed).toEqual([]);
      expect(result.skipped[0]?.reason).toContain("age floor");
      expect(await listNames(dir)).toHaveLength(2);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("defaults the age floor to one minute", () => {
    expect(DEFAULT_REAP_MIN_AGE_MS).toBe(60_000);
  });

  it("LEAVES another session's temp in the same directory", async () => {
    const dir = await makeDir();
    try {
      const mine = path.join(dir, "mine.jsonl");
      const theirs = path.join(dir, "theirs.jsonl");
      await writeFile(mine, "{}\n");
      await writeFile(theirs, "{}\n");
      await makeOldFile(dir, rewriteTempPath(theirs, DEAD_PID).split("/").pop()!);

      const result = await reapStaleRewriteTemps(mine, { minAgeMs: 0 });
      expect(result.removed).toEqual([]);
      expect(await listNames(dir)).toContain("theirs.jsonl.rewrite-999999.tmp");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("LEAVES an unrelated file that a prefix-agnostic parse would misread", async () => {
    // Contains `.rewrite-`, ends in `.tmp`, and bytes [17,19) are digits —
    // so a parse that only checked `includes(".rewrite-")` plus a numeric
    // tail would read this as our pid "23" and delete it. Only the
    // exact-basename anchor saves it, which is why that anchor earns its
    // place rather than being cosmetic.
    const dir = await makeDir();
    try {
      const file = path.join(dir, "abc.jsonl");
      await writeFile(file, "{}\n");
      await makeOldFile(dir, ".rewrite-aaaaaaaa123.tmp");

      const result = await reapStaleRewriteTemps(file, { minAgeMs: 0 });
      expect(result.removed).toEqual([]);
      expect(await listNames(dir)).toContain(".rewrite-aaaaaaaa123.tmp");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("LEAVES unrelated files and the session itself", async () => {
    const dir = await makeDir();
    try {
      const file = path.join(dir, "abc.jsonl");
      await writeFile(file, "{}\n");
      await makeOldFile(dir, "notes.txt");
      await makeOldFile(dir, `${path.basename(file)}.lock`);

      const result = await reapStaleRewriteTemps(file, { minAgeMs: 0 });
      expect(result.removed).toEqual([]);
      expect(await listNames(dir)).toEqual([
        "abc.jsonl",
        "abc.jsonl.lock",
        "notes.txt",
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("never touches its own pid's temp", async () => {
    const dir = await makeDir();
    try {
      const file = path.join(dir, "abc.jsonl");
      await writeFile(file, "{}\n");
      await makeOldFile(
        dir,
        rewriteTempPath(file, process.pid).split("/").pop()!,
      );

      const result = await reapStaleRewriteTemps(file, { minAgeMs: 0 });
      expect(result.removed).toEqual([]);
      expect(result.skipped[0]?.reason).toContain("current process");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("removes several orphans at once", async () => {
    const dir = await makeDir();
    try {
      const file = path.join(dir, "abc.jsonl");
      await writeFile(file, "{}\n");
      await makeOldFile(dir, rewriteTempPath(file, 111_111).split("/").pop()!);
      await makeOldFile(dir, rewriteTempPath(file, 222_222).split("/").pop()!);

      const result = await reapStaleRewriteTemps(file, { minAgeMs: 0 });
      expect(result.removed).toHaveLength(2);
      expect(await listNames(dir)).toEqual(["abc.jsonl"]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("never rejects: a missing directory is a no-op", async () => {
    const result = await reapStaleRewriteTemps("/nope/definitely-missing.jsonl");
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("never rejects: a refused unlink is reported as a skip", async () => {
    const dir = await makeDir();
    try {
      const file = path.join(dir, "abc.jsonl");
      await writeFile(file, "{}\n");
      await makeOldFile(dir, rewriteTempPath(file, DEAD_PID).split("/").pop()!);

      const result = await reapStaleRewriteTemps(file, {
        minAgeMs: 0,
        unlink: async () => {
          throw new Error("EPERM");
        },
      });
      expect(result.removed).toEqual([]);
      expect(result.skipped[0]?.reason).toBe("unlink failed");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("never rejects: an unreadable temp is reported as a skip", async () => {
    const dir = await makeDir();
    try {
      const file = path.join(dir, "abc.jsonl");
      await writeFile(file, "{}\n");
      await makeOldFile(dir, rewriteTempPath(file, DEAD_PID).split("/").pop()!);

      const result = await reapStaleRewriteTemps(file, {
        statMtimeMs: async () => {
          throw new Error("EACCES");
        },
      });
      expect(result.removed).toEqual([]);
      expect(result.skipped[0]?.reason).toBe("stat failed");
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe("PersistedSession sweeps litter when it opens", () => {
  it("removes a dead writer's temp and keeps the transcript intact", async () => {
    const dir = await makeDir();
    const filePath = path.join(dir, "sweep.jsonl");
    try {
      // A real session, closed cleanly, plus an orphan from a "crash".
      const session = await PersistedSession.create({
        id: "sweep",
        metadata: {
          cwd: dir,
          permissionMode: "read-only",
          startedAt: new Date().toISOString(),
        },
        filePath,
      });
      session.appendMessage("user", [{ type: "text", text: "keep me" }]);
      await session.close();

      const orphan = await makeOldFile(
        dir,
        rewriteTempPath(filePath, DEAD_PID).split("/").pop()!,
      );

      const reopened = await PersistedSession.open(filePath);
      expect(reopened.messages).toHaveLength(1);
      // The orphan is gone; the lease sidecar is legitimately present while
      // we hold the session open.
      expect(await stat(orphan).catch(() => undefined)).toBeUndefined();
      await reopened.close();
      expect(await listNames(dir)).toEqual([path.basename(filePath)]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("never fails to open because sweeping failed", async () => {
    const dir = await makeDir();
    const filePath = path.join(dir, "resilient.jsonl");
    try {
      const session = await PersistedSession.create({
        id: "resilient",
        metadata: {
          cwd: dir,
          permissionMode: "read-only",
          startedAt: new Date().toISOString(),
        },
        filePath,
      });
      await session.close();

      // Litter that cannot be removed (a directory, not a file).
      const stubborn = path.join(
        dir,
        rewriteTempPath(filePath, DEAD_PID).split("/").pop()!,
      );
      await import("node:fs/promises").then((fs) => fs.mkdir(stubborn));
      const when = new Date(Date.now() - 10 * 60_000);
      await utimes(stubborn, when, when);

      const reopened = await PersistedSession.open(filePath);
      expect(reopened.messages).toHaveLength(0);
      await reopened.close();
      // The stubborn entry is still there — it was skipped, not thrown on.
      expect(await listNames(dir)).toContain(path.basename(stubborn));
    } finally {
      await removeTempDir(dir);
    }
  });
});
