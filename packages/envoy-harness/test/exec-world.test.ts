/**
 * R4.14b — peer exec-world hermetic tests.
 */

import { describe, expect, it } from "vitest";

import {
  createPeerExecWorld,
  FakeRemoteExecTransport,
  InMemorySession,
  readFileTool,
  writeTool,
  makeBashTool,
  type ToolContext,
} from "../src/index.js";

function ctx(
  execWorld: ToolContext["execWorld"],
  permissionMode: "read-only" | "workspace-write" | "danger-full-access" = "danger-full-access",
): ToolContext {
  return {
    cwd: "/workspace",
    session: new InMemorySession("s1", {
      cwd: "/workspace",
      permissionMode,
      startedAt: new Date().toISOString(),
    }),
    abortSignal: new AbortController().signal,
    sandboxPolicy: {
      mode: permissionMode,
      approval: "never",
      backend: "none",
      writableRoots: permissionMode === "workspace-write" ? ["/workspace"] : [],
      networkAccess: false,
      slashTmpWritable: true,
    },
    ...(execWorld !== undefined ? { execWorld } : {}),
  };
}

describe("R4.14b peer exec-world", () => {
  it("routes read_file / write / bash to the worker peer fake", async () => {
    const transport = new FakeRemoteExecTransport({
      files: { "/workspace/hello.txt": "from-peer" },
      shell: (_peerId, req) => ({
        stdout: `ran:${req.command}`,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
    });
    const world = createPeerExecWorld({
      peerId: "worker-1",
      transport,
    });
    expect(world.target).toEqual({ kind: "peer", peerId: "worker-1" });

    const toolCtx = ctx(world);
    const read = await readFileTool.execute(
      { path: "hello.txt" },
      toolCtx,
    );
    expect(read.isError).toBeFalsy();
    expect(read.content).toBe("from-peer");

    const wrote = await writeTool.execute(
      { path: "out.txt", content: "written-on-peer" },
      toolCtx,
    );
    expect(wrote.isError).toBeFalsy();
    expect(transport.getFile("/workspace/out.txt")).toBe("written-on-peer");

    const bash = makeBashTool();
    const shell = await bash.execute({ command: "echo hi" }, toolCtx);
    expect(shell.isError).toBeFalsy();
    expect(String(shell.content)).toContain("ran:echo hi");
    expect(String(shell.content)).toContain("peer://worker-1");
  });

  it("rejects background bash on peer exec-world", async () => {
    const world = createPeerExecWorld({
      peerId: "w",
      transport: new FakeRemoteExecTransport(),
    });
    const bash = makeBashTool();
    const result = await bash.execute(
      { command: "sleep 1", background: true },
      ctx(world),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/not supported on peer exec-world/);
  });
});
