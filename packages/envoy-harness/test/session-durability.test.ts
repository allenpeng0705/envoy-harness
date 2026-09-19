/**
 * Session durability + crash repair — hermetic tests.
 *
 * These cover the failure modes that made long runs untrustworthy:
 * a crash losing the record of a tool that already ran, a write error
 * being swallowed, a torn tail making a session unopenable, and a crash
 * during a plan/title rewrite truncating the transcript.
 *
 * Everything uses an in-memory filesystem seam — no real disk, no
 * timers, no wall clock.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DurableLineWriter,
  EMPTY_REPAIR_REPORT,
  UNKNOWN_OUTCOME_NOTICE,
  repairDanglingToolCalls,
  splitCompleteLines,
  type DurableFileHandle,
  type DurableFileSystem,
} from "../src/index.js";
import { rewriteTempPath } from "../src/index.js";
import type { Message } from "../src/index.js";

/** An in-memory filesystem that records every operation and can fail. */
function createFakeFs(initial = "") {
  const files = new Map<string, string>([["/s.jsonl", initial]]);
  const ops: string[] = [];
  let failNextWrite: Error | undefined;
  let failNextSync: Error | undefined;

  const fs: DurableFileSystem = {
    async open(filePath, _flags) {
      ops.push(`open:${filePath}`);
      const handle: DurableFileHandle = {
        async writeFile(data) {
          if (failNextWrite !== undefined) {
            const err = failNextWrite;
            failNextWrite = undefined;
            ops.push(`write-fail:${filePath}`);
            throw err;
          }
          ops.push(`write:${filePath}`);
          files.set(filePath, (files.get(filePath) ?? "") + data);
        },
        async sync() {
          if (failNextSync !== undefined) {
            const err = failNextSync;
            failNextSync = undefined;
            ops.push(`sync-fail:${filePath}`);
            throw err;
          }
          ops.push(`sync:${filePath}`);
        },
        async truncate(length) {
          ops.push(`truncate:${filePath}:${length}`);
          files.set(filePath, (files.get(filePath) ?? "").slice(0, length));
        },
        async close() {
          ops.push(`close:${filePath}`);
        },
      };
      return handle;
    },
    async stat(filePath) {
      return { size: Buffer.byteLength(files.get(filePath) ?? "", "utf8") };
    },
    async writeFile(filePath, data) {
      if (failNextWrite !== undefined) {
        const err = failNextWrite;
        failNextWrite = undefined;
        ops.push(`writeFile-fail:${filePath}`);
        throw err;
      }
      ops.push(`writeFile:${filePath}`);
      files.set(filePath, data);
    },
    async truncate(filePath, length) {
      ops.push(`truncate:${filePath}:${length}`);
      files.set(filePath, (files.get(filePath) ?? "").slice(0, length));
    },
    async rename(from, to) {
      ops.push(`rename:${from}->${to}`);
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    async syncDir(dirPath) {
      ops.push(`syncDir:${dirPath}`);
    },
  };

  return {
    fs,
    ops,
    read: (p = "/s.jsonl") => files.get(p) ?? "",
    has: (p: string) => files.has(p),
    failWrite: (err = new Error("ENOSPC: no space left on device")) => {
      failNextWrite = err;
    },
    failSync: (err = new Error("EIO: i/o error")) => {
      failNextSync = err;
    },
  };
}

function makeWriter(fake: ReturnType<typeof createFakeFs>, onError?: (e: Error) => void) {
  return new DurableLineWriter({
    filePath: "/s.jsonl",
    fs: fake.fs,
    fsync: true,
    batchDelayMs: 1_000_000, // never auto-flush; tests drive flush explicitly
    ...(onError !== undefined ? { onError } : {}),
  });
}

describe("DurableLineWriter — durability", () => {
  it("buffers appends and makes them durable only on flush", async () => {
    const fake = createFakeFs("");
    const writer = makeWriter(fake);

    writer.append('{"a":1}');
    expect(writer.bufferedBytes).toBeGreaterThan(0);
    expect(fake.read()).toBe(""); // not on disk yet

    await writer.flush();
    expect(fake.read()).toBe('{"a":1}\n');
    expect(writer.bufferedBytes).toBe(0);
  });

  it("fsyncs each batch", async () => {
    const fake = createFakeFs("");
    const writer = makeWriter(fake);
    writer.append("line");
    await writer.flush();
    expect(fake.ops.filter((o) => o.startsWith("sync:"))).toHaveLength(1);
  });

  it("writes many appends as ONE batch (one open/write/sync)", async () => {
    const fake = createFakeFs("");
    const writer = makeWriter(fake);
    for (let i = 0; i < 500; i++) writer.append(`{"i":${i}}`);
    await writer.flush();

    expect(fake.ops.filter((o) => o.startsWith("open:"))).toHaveLength(1);
    expect(fake.ops.filter((o) => o.startsWith("write:"))).toHaveLength(1);
    expect(fake.read().trim().split("\n")).toHaveLength(500);
  });

  it("preserves append order across batches", async () => {
    const fake = createFakeFs("");
    const writer = makeWriter(fake);
    writer.append("a");
    await writer.flush();
    writer.append("b");
    writer.append("c");
    await writer.flush();
    expect(fake.read()).toBe("a\nb\nc\n");
  });

  it("honors the batch-size threshold without an explicit flush", async () => {
    const fake = createFakeFs("");
    const writer = new DurableLineWriter({
      filePath: "/s.jsonl",
      fs: fake.fs,
      maxBatchBytes: 16,
      batchDelayMs: 1_000_000,
    });
    writer.append("0123456789");
    expect(fake.read()).toBe("");
    writer.append("0123456789"); // exceeds 16 bytes → drains
    await writer.flush();
    expect(fake.read()).toBe("0123456789\n0123456789\n");
  });
});

describe("DurableLineWriter — failure handling", () => {
  it("REJECTS flush on a write failure instead of swallowing it", async () => {
    const fake = createFakeFs("");
    const onError = vi.fn();
    const writer = makeWriter(fake, onError);
    fake.failWrite();

    writer.append("lost");
    await expect(writer.flush()).rejects.toThrow(/ENOSPC/);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("rolls back a partial append so the file is never left torn", async () => {
    const fake = createFakeFs("existing\n");
    const writer = makeWriter(fake);
    fake.failWrite();

    writer.append("new");
    await expect(writer.flush()).rejects.toThrow();
    // Truncate back to the pre-append size.
    expect(fake.ops).toContain("truncate:/s.jsonl:9");
    expect(fake.read()).toBe("existing\n");
  });

  it("re-buffers a failed batch so a later flush retries it", async () => {
    const fake = createFakeFs("");
    const writer = makeWriter(fake);
    fake.failWrite();
    writer.append("retry-me");
    await expect(writer.flush()).rejects.toThrow();

    // A transient error clears; the data was not lost.
    await writer.flush();
    expect(fake.read()).toBe("retry-me\n");
  });

  it("treats a sync failure as a durability failure", async () => {
    const fake = createFakeFs("");
    const writer = makeWriter(fake);
    fake.failSync();
    writer.append("x");
    await expect(writer.flush()).rejects.toThrow(/EIO/);
  });

  it("reports each distinct failure once and clears after reporting", async () => {
    const fake = createFakeFs("");
    const writer = makeWriter(fake);
    fake.failWrite(new Error("first"));
    writer.append("a");
    await expect(writer.flush()).rejects.toThrow("first");
    expect(writer.hasPendingError).toBe(false);

    fake.failWrite(new Error("second"));
    writer.append("b");
    await expect(writer.flush()).rejects.toThrow("second");
  });
});

describe("DurableLineWriter — atomic rewrite", () => {
  it("publishes via a temp file + rename, never truncating in place", async () => {
    const fake = createFakeFs("old\ncontent\n");
    const writer = makeWriter(fake);
    writer.rewrite("brand\nnew\n");
    await writer.flush();

    expect(fake.read()).toBe("brand\nnew\n");
    const renames = fake.ops.filter((o) => o.startsWith("rename:"));
    expect(renames).toHaveLength(1);
    // The temp name must come from `rewriteTempPath`, because
    // `reapStaleRewriteTemps` recognises orphans by exactly that shape. If
    // the two ever drift, reaping silently stops working — no error, just
    // litter that never gets swept. Pin the contract, not "something .tmp".
    const expected = rewriteTempPath("/s.jsonl", process.pid);
    expect(renames[0]).toBe(`rename:${expected}->/s.jsonl`);
  });

  it("fsyncs the containing directory after the rename", async () => {
    // A rename updates the directory entry; fsyncing only the file would
    // leave the new NAME losable on a crash.
    const fake = createFakeFs("old\n");
    const writer = makeWriter(fake);
    writer.rewrite("new\n");
    await writer.flush();

    const renameAt = fake.ops.findIndex((o) => o.startsWith("rename:"));
    const syncDirAt = fake.ops.findIndex((o) => o.startsWith("syncDir:"));
    expect(renameAt).toBeGreaterThanOrEqual(0);
    expect(syncDirAt).toBeGreaterThan(renameAt);
    expect(fake.ops[syncDirAt]).toBe("syncDir:/");
  });

  it("subsumes buffered appends (the caller serializes the full transcript)", async () => {
    const fake = createFakeFs("");
    const writer = makeWriter(fake);
    writer.append("buffered");
    writer.rewrite("header\nbody\n");
    await writer.flush();
    expect(fake.read()).toBe("header\nbody\n");
  });

  it("keeps the previous content when the rewrite write fails", async () => {
    const fake = createFakeFs("precious\n");
    const writer = makeWriter(fake);
    fake.failWrite(new Error("disk full"));
    writer.rewrite("replacement\n");
    await expect(writer.flush()).rejects.toThrow(/disk full/);
    // Rename never ran, so the original file is intact.
    expect(fake.read()).toBe("precious\n");
  });
});

describe("splitCompleteLines", () => {
  it("returns complete lines for a well-formed file", () => {
    const { lines, torn } = splitCompleteLines('{"a":1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(torn).toBeUndefined();
  });

  it("drops a torn final line and reports it", () => {
    const { lines, torn } = splitCompleteLines('{"a":1}\n{"role":"assis');
    expect(lines).toEqual(['{"a":1}']);
    expect(torn).toBe('{"role":"assis');
  });

  it("handles an empty file", () => {
    expect(splitCompleteLines("")).toEqual({ lines: [], torn: undefined });
  });

  it("handles a file that is only a torn line", () => {
    const { lines, torn } = splitCompleteLines('{"half"');
    expect(lines).toEqual([]);
    expect(torn).toBe('{"half"');
  });
});

describe("repairDanglingToolCalls", () => {
  const assistantWithCall = (id: string): Message => ({
    role: "assistant",
    content: [{ type: "tool_call", id, name: "bash", args: { command: "deploy" } }],
  });

  it("closes a tool_call whose result was never recorded", () => {
    const { messages, repaired } = repairDanglingToolCalls([
      assistantWithCall("call_1"),
    ]);
    expect(repaired).toBe(1);
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe("tool");
    expect(last.content[0]).toMatchObject({
      type: "tool_result",
      toolCallId: "call_1",
      isError: true,
    });
    // The notice must warn against a blind retry of a side effect.
    expect(String((last.content[0] as { content: unknown }).content)).toContain(
      "UNKNOWN",
    );
    expect(UNKNOWN_OUTCOME_NOTICE).toContain("Do NOT retry it");
  });

  it("leaves a satisfied transcript untouched", () => {
    const before: Message[] = [
      assistantWithCall("call_1"),
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "call_1", content: "ok", isError: false },
        ],
      },
    ];
    const { messages, repaired } = repairDanglingToolCalls(before);
    expect(repaired).toBe(0);
    expect(messages).toEqual(before);
  });

  it("closes only the unmatched calls in a partial transcript", () => {
    const { repaired } = repairDanglingToolCalls([
      assistantWithCall("call_1"),
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "call_1", content: "ok", isError: false },
        ],
      },
      assistantWithCall("call_2"),
    ]);
    expect(repaired).toBe(1);
  });

  it("closes several dangling calls in one synthetic message", () => {
    const { messages, repaired } = repairDanglingToolCalls([
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "c1", name: "bash", args: {} },
          { type: "tool_call", id: "c2", name: "bash", args: {} },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "c1", content: "ok", isError: false },
        ],
      },
    ]);
    expect(repaired).toBe(1);
    expect(messages[messages.length - 1]!.content).toHaveLength(1);
  });

  it("SKIPS repair when a tool_result has no toolCallId", () => {
    // Unlabelled results cannot be matched, so repairing would append a
    // spurious error next to a real (if badly labelled) result. Older
    // logs and hand-written fixtures hit this.
    const { messages, repaired } = repairDanglingToolCalls([
      assistantWithCall("call_1"),
      {
        role: "tool",
        content: [{ type: "tool_result", content: "the real result" } as never],
      },
    ]);
    expect(repaired).toBe(0);
    expect(messages).toHaveLength(2);
  });

  it("still repairs when labelled results leave a genuine gap", () => {
    const { repaired } = repairDanglingToolCalls([
      assistantWithCall("call_1"),
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "call_1", content: "ok", isError: false },
        ],
      },
      assistantWithCall("call_2"),
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "call_2", content: "ok", isError: false },
        ],
      },
      assistantWithCall("call_3"),
    ]);
    expect(repaired).toBe(1);
  });

  it("is a no-op on an empty transcript", () => {
    const { messages, repaired } = repairDanglingToolCalls([]);
    expect(messages).toEqual([]);
    expect(repaired).toBe(0);
    expect(EMPTY_REPAIR_REPORT.danglingToolCalls).toBe(0);
  });
});
