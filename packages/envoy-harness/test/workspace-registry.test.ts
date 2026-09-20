/**
 * Workspace (project) registry.
 *
 * The registry is what makes "open a different project" possible without
 * restarting the host: an ordered, durable list of project directories
 * that is independent of which directory the process started in. These
 * tests pin the ordering, the idempotence, the safety property (removing
 * a project never deletes the directory) and the failure modes.
 */

import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFileWorkspaceRegistry,
  WorkspaceError,
  workspaceRootsFromEnv,
  type WorkspaceRegistry,
} from "../src/index.js";
import { removeTempDir } from "./support/tmp-dir.js";

let tmpDir: string;
let filePath: string;
let registry: WorkspaceRegistry;
let projectA: string;
let projectB: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-workspace-"));
  filePath = path.join(tmpDir, "workspaces.json");
  projectA = path.join(tmpDir, "alpha");
  projectB = path.join(tmpDir, "beta");
  await fs.mkdir(projectA, { recursive: true });
  await fs.mkdir(projectB, { recursive: true });
  registry = createFileWorkspaceRegistry({
    filePath,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
});

afterEach(async () => {
  await removeTempDir(tmpDir);
});

describe("workspace registry", () => {
  it("starts empty when the file does not exist", async () => {
    expect(await registry.list()).toEqual([]);
  });

  it("adds a project with a basename default and persists it", async () => {
    const entry = await registry.add(projectA);
    // Identity is the canonical (symlink-resolved) path — on macOS
    // os.tmpdir() itself is a symlink to /private/var, so this is not
    // merely cosmetic: it is the same canonicalization that makes the
    // allowed-roots check sound.
    expect(entry.path).toBe(await fs.realpath(projectA));
    expect(entry.name).toBe("alpha");
    expect(entry.addedAt).toBe("2026-01-01T00:00:00.000Z");

    // A second registry over the same file sees it (persistence).
    const reopened = createFileWorkspaceRegistry({ filePath });
    expect((await reopened.list()).map((e) => e.name)).toEqual(["alpha"]);
  });

  it("rejects a relative path instead of resolving it against the server's cwd", async () => {
    await expect(registry.add("relative/project")).rejects.toMatchObject({
      code: "NOT_ABSOLUTE",
    });
  });

  it("honours an explicit name", async () => {
    const entry = await registry.add(projectA, { name: "Payments service" });
    expect(entry.name).toBe("Payments service");
  });

  it("is idempotent and moves a re-added project to the end", async () => {
    await registry.add(projectA);
    await registry.add(projectB);
    expect((await registry.list()).map((e) => e.name)).toEqual(["alpha", "beta"]);

    await registry.add(projectA);
    expect((await registry.list()).map((e) => e.name)).toEqual(["beta", "alpha"]);
    // Re-adding does not reset when it was first added.
    const alpha = (await registry.list()).find((e) => e.name === "alpha");
    expect(alpha?.addedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("removes a project WITHOUT touching the directory", async () => {
    await registry.add(projectA);
    expect(await registry.remove(projectA)).toBe(true);
    expect(await registry.list()).toEqual([]);
    // The whole point: forgetting a project is not deleting it.
    expect((await fs.stat(projectA)).isDirectory()).toBe(true);
  });

  it("removing an unknown project is a no-op that reports false", async () => {
    expect(await registry.remove(projectB)).toBe(false);
    expect(await registry.list()).toEqual([]);
  });

  it("touch records last-used and leaves order alone", async () => {
    await registry.add(projectA);
    await registry.add(projectB);
    const touched = await registry.touch(projectA);
    expect(touched?.lastUsedAt).toBe("2026-01-01T00:00:00.000Z");
    expect((await registry.list()).map((e) => e.name)).toEqual(["alpha", "beta"]);
  });

  it("touch on an unknown project returns null", async () => {
    expect(await registry.touch(projectA)).toBeNull();
  });

  it("has() resolves relative paths against cwd", async () => {
    await registry.add(projectA);
    expect(await registry.has(projectA)).toBe(true);
    expect(await registry.has(projectB)).toBe(false);
  });

  it("rejects a path that is not a directory", async () => {
    const file = path.join(tmpDir, "a-file.txt");
    await fs.writeFile(file, "x", "utf8");
    await expect(registry.add(file)).rejects.toThrow(WorkspaceError);
    await expect(registry.add(file)).rejects.toMatchObject({
      code: "NOT_A_DIRECTORY",
    });
  });

  it("rejects a path that does not exist", async () => {
    await expect(registry.add(path.join(tmpDir, "nope"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects a malformed registry file instead of silently starting over", async () => {
    await fs.writeFile(filePath, "{ not json", "utf8");
    await expect(registry.list()).rejects.toMatchObject({
      code: "MALFORMED_FILE",
    });
  });

  it("rejects an unsupported file shape", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({ formatVersion: 99, workspaces: [] }),
      "utf8",
    );
    await expect(registry.list()).rejects.toMatchObject({
      code: "MALFORMED_FILE",
    });
  });

  it("serializes concurrent adds without losing an entry", async () => {
    await Promise.all([
      registry.add(projectA),
      registry.add(projectB),
    ]);
    expect((await registry.list()).map((e) => e.name).sort()).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("leaves no temp file behind after a write", async () => {
    await registry.add(projectA);
    const files = await fs.readdir(tmpDir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("workspace registry: allowed roots", () => {
  function rooted(roots: ReadonlyArray<string>): WorkspaceRegistry {
    return createFileWorkspaceRegistry({ filePath, allowedRoots: roots });
  }

  it("accepts a directory inside a root", async () => {
    const scoped = rooted([tmpDir]);
    const entry = await scoped.add(projectA);
    expect(entry.name).toBe("alpha");
  });

  it("rejects a directory outside every root", async () => {
    const scoped = rooted([projectA]);
    await expect(scoped.add(projectB)).rejects.toMatchObject({
      code: "OUTSIDE_ROOTS",
    });
  });

  it("does not treat a sibling with a shared prefix as inside the root", async () => {
    // /tmp/x/proj must not be considered inside /tmp/x/pro — a naive
    // `startsWith` without a separator does exactly that.
    const inside = path.join(tmpDir, "pro");
    const sibling = path.join(tmpDir, "project-other");
    await fs.mkdir(inside, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
    const scoped = rooted([inside]);
    await expect(scoped.add(sibling)).rejects.toMatchObject({
      code: "OUTSIDE_ROOTS",
    });
  });

  it.skipIf(process.platform === "win32")(
    "cannot be escaped with a symlink inside a root",
    async () => {
      const allowed = path.join(tmpDir, "allowed");
      const secret = path.join(tmpDir, "secret");
      await fs.mkdir(allowed, { recursive: true });
      await fs.mkdir(secret, { recursive: true });
      const link = path.join(allowed, "escape");
      await fs.symlink(secret, link, "dir");

      const scoped = rooted([allowed]);
      // The check runs on the REAL path, so the link is rejected.
      await expect(scoped.add(link)).rejects.toMatchObject({
        code: "OUTSIDE_ROOTS",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "unifies a directory reached through a symlink",
    async () => {
      await registry.add(projectA);
      const link = path.join(tmpDir, "alpha-link");
      await fs.symlink(projectA, link, "dir");
      const entry = await registry.add(link);
      expect(entry.path).toBe(await fs.realpath(projectA));
      expect(await registry.list()).toHaveLength(1);
    },
  );

  it("remove still works for a project whose directory is gone", async () => {
    // Forgetting a deleted project must not require the directory to
    // exist; canonicalization falls back to the logical path.
    await registry.add(projectB);
    await fs.rm(projectB, { recursive: true, force: true });
    expect(await registry.remove(projectB)).toBe(true);
    expect(await registry.list()).toEqual([]);
  });
});

describe("workspaceRootsFromEnv", () => {
  it("returns [] when unset or blank", () => {
    expect(workspaceRootsFromEnv({})).toEqual([]);
    expect(workspaceRootsFromEnv({ ENVOY_WORKSPACE_ROOTS: "   " })).toEqual([]);
  });

  it("splits on the platform path delimiter", () => {
    const env = { ENVOY_WORKSPACE_ROOTS: `/a${path.delimiter}/b` };
    expect(workspaceRootsFromEnv(env)).toEqual(["/a", "/b"]);
  });
});
