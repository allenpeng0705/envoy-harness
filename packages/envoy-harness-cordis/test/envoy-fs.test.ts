/**
 * C2 tests — the sandbox-gated envoy fs adapter over the dsh `ctx.fs`
 * contract: contract coverage (resolve/stat/readText/listDir/writeText/
 * editText) + sandbox enforcement (writes outside writable roots and any
 * write in read-only mode are denied).
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SandboxPolicy } from "@envoymesh/envoy-harness";
import { EnvoyFileSystem } from "../src/index.js";

let tmpDir: string;
let insideDir: string;
let outsideDir: string;

function workspacePolicy(): SandboxPolicy {
  return {
    mode: "workspace-write",
    approval: "on-request",
    backend: "none",
    writableRoots: [insideDir],
    networkAccess: false,
    slashTmpWritable: true,
  };
}

function readOnlyPolicy(): SandboxPolicy {
  return {
    mode: "read-only",
    approval: "on-request",
    backend: "none",
    writableRoots: [],
    networkAccess: false,
    slashTmpWritable: true,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-fs-"));
  insideDir = path.join(tmpDir, "inside");
  outsideDir = path.join(tmpDir, "outside");
  await fs.mkdir(insideDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeFs(policy: SandboxPolicy): Promise<EnvoyFileSystem> {
  const { Context } = await import("@deepseek-ai/cordis");
  return new EnvoyFileSystem(new Context(), { policy, cwd: tmpDir });
}

describe("EnvoyFileSystem (dsh ctx.fs contract)", () => {
  it("resolves, stats, reads, and lists a fixture directory", async () => {
    const f = await makeFs(workspacePolicy());
    const file = path.join(insideDir, "hello.txt");
    await fs.writeFile(file, "hello world");

    const target = await f.resolve(file);
    expect(target.displayPath).toBe(await fs.realpath(file));

    const info = await f.stat(target);
    expect(info?.type).toBe("file");
    expect(info?.size).toBe(11);

    expect(await f.readText(target)).toBe("hello world");

    const dirTarget = await f.resolve(insideDir);
    const entries = await f.listDir(dirTarget);
    expect(entries.map((e) => e.name)).toEqual(["hello.txt"]);
    expect(entries[0]?.type).toBe("file");
  });

  it("writes atomically with create/replace intents + versions", async () => {
    const f = await makeFs(workspacePolicy());
    const target = await f.resolve(path.join(insideDir, "out.txt"));

    const created = await f.writeText(target, "v1", { kind: "createIfAbsent" });
    expect(created.operation).toBe("create");
    expect(created.before).toBeNull();

    // createIfAbsent on an existing file → FS_NOT_OBSERVED.
    await expect(
      f.writeText(target, "v2", { kind: "createIfAbsent" }),
    ).rejects.toMatchObject({ code: "FS_NOT_OBSERVED" });

    // replaceIfVersion with a stale version → FS_STALE_VERSION.
    await expect(
      f.writeText(target, "v2", {
        kind: "replaceIfVersion",
        version: "nope" as never,
      }),
    ).rejects.toMatchObject({ code: "FS_STALE_VERSION" });

    const updated = await f.writeText(target, "v2", {
      kind: "replaceIfVersion",
      version: created.version,
    });
    expect(updated.operation).toBe("update");
    expect(updated.before).toBe("v1");
    expect(await f.readText(target)).toBe("v2");
  });

  it("edits literal text (single, replaceAll, ambiguous, missing)", async () => {
    const f = await makeFs(workspacePolicy());
    const target = await f.resolve(path.join(insideDir, "edit.txt"));
    await f.writeText(target, "a\nb\na");

    const single = await f.editText(target, {
      oldString: "b",
      newString: "B",
      replaceAll: false,
    });
    expect(single.after).toBe("a\nB\na");

    // Ambiguous single edit → FS_AMBIGUOUS_EDIT.
    await expect(
      f.editText(target, { oldString: "a", newString: "A", replaceAll: false }),
    ).rejects.toMatchObject({ code: "FS_AMBIGUOUS_EDIT" });

    const all = await f.editText(target, {
      oldString: "a",
      newString: "A",
      replaceAll: true,
    });
    expect(all.after).toBe("A\nB\nA");

    await expect(
      f.editText(target, { oldString: "zzz", newString: "x", replaceAll: false }),
    ).rejects.toMatchObject({ code: "FS_EDIT_NOT_FOUND" });
  });
});

describe("EnvoyFileSystem sandbox enforcement", () => {
  it("denies writes outside the writable roots with FS_SANDBOX_DENIED", async () => {
    const f = await makeFs(workspacePolicy());
    const target = await f.resolve(path.join(outsideDir, "escape.txt"));
    await expect(f.writeText(target, "x")).rejects.toMatchObject({
      code: "FS_SANDBOX_DENIED",
    });
    await expect(
      fs.readFile(path.join(outsideDir, "escape.txt")),
    ).rejects.toThrow();
  });

  it("denies every write in read-only mode", async () => {
    const f = await makeFs(readOnlyPolicy());
    const target = await f.resolve(path.join(insideDir, "nope.txt"));
    await expect(f.writeText(target, "x")).rejects.toMatchObject({
      code: "FS_SANDBOX_DENIED",
    });
  });

  it("still allows reads outside the writable roots", async () => {
    const f = await makeFs(workspacePolicy());
    const file = path.join(outsideDir, "read.txt");
    await fs.writeFile(file, "readable");
    const target = await f.resolve(file);
    expect(await f.readText(target)).toBe("readable");
  });
});
