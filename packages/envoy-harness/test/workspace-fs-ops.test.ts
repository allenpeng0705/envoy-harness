import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachWorkspaceFileOp,
  listWorkspaceFsOp,
  readWorkspaceFsOp,
} from "../src/protocol/workspace-fs-ops.js";
import { WorkspaceError } from "../src/workspace/index.js";

const tmpDirs: string[] = [];

async function makeRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eh-fs-"));
  tmpDirs.push(dir);
  await fs.writeFile(path.join(dir, "hello.txt"), "hello world");
  await fs.mkdir(path.join(dir, "sub"));
  await fs.writeFile(path.join(dir, "sub", "nested.txt"), "nested");
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) await fs.rm(d, { recursive: true, force: true });
  }
});

describe("workspace-fs-ops", () => {
  it("lists one level under cwd", async () => {
    const root = await makeRoot();
    const { entries } = await listWorkspaceFsOp({ rootCwd: root });
    const names = entries.map((e) => e.name).sort();
    expect(names).toContain("hello.txt");
    expect(names).toContain("sub");
    expect(entries.find((e) => e.name === "sub")?.kind).toBe("dir");
  });

  it("rejects path escape via ..", async () => {
    const root = await makeRoot();
    await expect(
      listWorkspaceFsOp({ rootCwd: root, path: ".." }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("reads text and flags binary", async () => {
    const root = await makeRoot();
    const text = await readWorkspaceFsOp({
      rootCwd: root,
      path: "hello.txt",
    });
    expect(text.text).toBe("hello world");
    expect(text.binary).toBeUndefined();

    await fs.writeFile(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 0]));
    const bin = await readWorkspaceFsOp({
      rootCwd: root,
      path: "bin.dat",
    });
    expect(bin.binary).toBe(true);
  });

  it("attach writes under .envoy-attachments", async () => {
    const root = await makeRoot();
    const dataBase64 = Buffer.from("payload").toString("base64");
    const res = await attachWorkspaceFileOp({
      rootCwd: root,
      name: "note.txt",
      dataBase64,
      mimeType: "text/plain",
    });
    expect(res.relativePath.startsWith(".envoy-attachments/")).toBe(true);
    const written = await fs.readFile(res.path, "utf8");
    expect(written).toBe("payload");
  });
});
