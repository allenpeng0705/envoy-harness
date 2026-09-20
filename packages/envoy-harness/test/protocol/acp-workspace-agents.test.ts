/**
 * ACP surface for the two capabilities that make the harness usable as a
 * multi-project, multi-agent workspace:
 *
 * - `workspace/list|add|remove` — the durable project list, so a client
 *   can open a project other than the one the server started in.
 * - `session/agent_message` / `session/agent_interrupt` — steering a
 *   background (continuable) child from the UI.
 *
 * Two levels are covered on purpose: the JSON-RPC dispatch (param
 * validation, "not supported" when a host did not wire the capability)
 * and the backend methods themselves.
 */

import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachAcpServer,
  createAgentSessionBackend,
  createFakeSessionBackend,
  createInProcessJsonRpcPair,
  type ProtocolSessionBackend,
} from "../../src/protocol/index.js";
import {
  createFileWorkspaceRegistry,
  type Agent,
  type ContinuableSubagentHandle,
} from "../../src/index.js";
import { removeTempDir } from "../support/tmp-dir.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "envoy-acp-ws-"));
});

afterEach(async () => {
  await removeTempDir(tmpDir);
});

/** A minimal Agent exposing only what the backend seam reads. */
function fakeAgent(submitter?: unknown): Agent {
  return {
    getMeshSubmitter: () => submitter,
    abort: () => undefined,
  } as unknown as Agent;
}

describe("ACP dispatch: workspace + agent control", () => {
  it("routes the five methods to the backend with parsed params", async () => {
    const calls: unknown[] = [];
    const backend = {
      createSession: async () => ({ sessionId: "s1" }),
      prompt: async () => ({ stopReason: "end_turn" }),
      cancel: () => undefined,
      listWorkspaces: async () => ({
        workspaces: [
          { path: "/p", name: "p", addedAt: "2026-01-01T00:00:00.000Z" },
        ],
      }),
      addWorkspace: async (p: { path: string; name?: string }) => {
        calls.push(["add", p]);
        return {
          workspace: {
            path: p.path,
            name: p.name ?? path.basename(p.path),
            addedAt: "2026-01-01T00:00:00.000Z",
          },
        };
      },
      removeWorkspace: async (p: { path: string }) => {
        calls.push(["remove", p]);
        return { removed: p.path === "/p" };
      },
      sendAgentMessage: async (p: unknown) => {
        calls.push(["send", p]);
        return { queued: true, status: "running" };
      },
      interruptAgent: async (p: unknown) => {
        calls.push(["interrupt", p]);
        return { interrupted: true, status: "failed" };
      },
    } as unknown as ProtocolSessionBackend;

    const pair = createInProcessJsonRpcPair();
    const dispose = attachAcpServer({ connection: pair.server, backend });
    await pair.client.request("initialize", {});
    await pair.client.request("session/new", {});

    const listed = (await pair.client.request("workspace/list", {})) as {
      workspaces: Array<{ name: string }>;
    };
    expect(listed.workspaces.map((w) => w.name)).toEqual(["p"]);

    await pair.client.request("workspace/add", {
      path: "/tmp/proj",
      name: "My project",
    });
    expect(calls.at(-1)).toEqual([
      "add",
      { path: "/tmp/proj", name: "My project" },
    ]);

    const removed = (await pair.client.request("workspace/remove", {
      path: "/p",
    })) as { removed: boolean };
    expect(removed.removed).toBe(true);

    const sent = (await pair.client.request("session/agent_message", {
      sessionId: "s1",
      agentId: "child-1",
      message: "keep going",
    })) as { queued: boolean };
    expect(sent.queued).toBe(true);
    expect(calls.at(-1)).toEqual([
      "send",
      { sessionId: "s1", agentId: "child-1", message: "keep going" },
    ]);

    const stopped = (await pair.client.request("session/agent_interrupt", {
      sessionId: "s1",
      agentId: "child-1",
      reason: "wrong direction",
    })) as { interrupted: boolean };
    expect(stopped.interrupted).toBe(true);

    dispose();
    pair.close();
  });

  it("reports 'not supported' when the host wired neither capability", async () => {
    const pair = createInProcessJsonRpcPair();
    const dispose = attachAcpServer({
      connection: pair.server,
      backend: createFakeSessionBackend(),
    });
    await pair.client.request("initialize", {});
    await expect(pair.client.request("workspace/list", {})).rejects.toThrow(
      /not supported/,
    );
    await expect(
      pair.client.request("session/agent_message", {
        sessionId: "s1",
        agentId: "a",
        message: "m",
      }),
    ).rejects.toThrow(/not supported/);
    dispose();
    pair.close();
  });

  it("rejects malformed params instead of guessing", async () => {
    const backend = {
      createSession: async () => ({ sessionId: "s1" }),
      prompt: async () => ({ stopReason: "end_turn" }),
      cancel: () => undefined,
      addWorkspace: async () => ({
        workspace: {
          path: "/p",
          name: "p",
          addedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
      sendAgentMessage: async () => ({ queued: true, status: "running" }),
    } as unknown as ProtocolSessionBackend;
    const pair = createInProcessJsonRpcPair();
    const dispose = attachAcpServer({ connection: pair.server, backend });
    await pair.client.request("initialize", {});

    await expect(pair.client.request("workspace/add", {})).rejects.toThrow(
      /path required/,
    );
    // A relative path would resolve against the server's cwd, which is not
    // what a client meant by it.
    await expect(
      pair.client.request("workspace/add", { path: "relative/proj" }),
    ).rejects.toThrow(/must be absolute/);
    await expect(
      pair.client.request("session/agent_message", {
        sessionId: "s1",
        agentId: "a",
      }),
    ).rejects.toThrow(/message required/);
    await expect(
      pair.client.request("session/agent_message", {
        sessionId: "s1",
        message: "m",
      }),
    ).rejects.toThrow(/agentId required/);

    dispose();
    pair.close();
  });
});

describe("createAgentSessionBackend: workspaces", () => {
  it("serves the registry and refuses when none is wired", async () => {
    const projectDir = path.join(tmpDir, "proj");
    await fs.mkdir(projectDir, { recursive: true });
    const registry = createFileWorkspaceRegistry({
      filePath: path.join(tmpDir, "workspaces.json"),
    });
    const withRegistry = createAgentSessionBackend({
      createAgent: () => fakeAgent(),
      workspaces: registry,
    });
    expect(await withRegistry.listWorkspaces?.()).toEqual({ workspaces: [] });
    const added = await withRegistry.addWorkspace?.({ path: projectDir });
    expect(added?.workspace.name).toBe("proj");
    expect((await withRegistry.listWorkspaces?.())?.workspaces).toHaveLength(1);
    expect(await withRegistry.removeWorkspace?.({ path: projectDir })).toEqual({
      removed: true,
    });

    const without = createAgentSessionBackend({
      createAgent: () => fakeAgent(),
    });
    // Unwired is an empty list (not an error): "no projects yet" and
    // "project support is off" are indistinguishable to a picker, and an
    // empty list is the honest answer in both cases.
    expect(await without.listWorkspaces?.()).toEqual({ workspaces: [] });
    await expect(without.addWorkspace?.({ path: projectDir })).rejects.toThrow(
      /not wired/,
    );
  });
});

describe("createAgentSessionBackend: session/agents carries the full id", () => {
  it("exposes the untruncated id so a client can steer without parsing prose", async () => {
    // A real child id is a 36-char UUID. The human-readable rendering
    // shortens it to 8 chars + "…", which is fine for a terminal and
    // useless as a handle — so the structured list must carry both the
    // full id and whether steering would currently reach a handle.
    const fullId = "11111111-2222-3333-4444-555555555555";
    const record = {
      sessionId: fullId,
      capabilityTag: "code-search",
      objective: "find the callers",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "running" as const,
    };
    const submitter = {
      submit: async () => {
        throw new Error("unused");
      },
      listSubagents: () => [record],
      getHandle: (id: string) =>
        id === fullId
          ? ({
              id: fullId,
              sessionId: fullId,
              output: () => "working on it",
              status: () => ({ status: "running" }),
            } as never)
          : undefined,
    };
    const backend = createAgentSessionBackend({
      createAgent: () => fakeAgent(submitter),
    });
    const { sessionId } = await backend.createSession({});
    const listed = await backend.listSessionAgents?.({ sessionId });
    expect(listed?.agents).toHaveLength(1);
    expect(listed?.agents?.[0]?.id).toBe(fullId);
    expect(listed?.agents?.[0]?.steerable).toBe(true);
    // A running child ships a tail of its live output so a UI can show
    // progress without a second round trip.
    expect(listed?.agents?.[0]?.outputPreview).toContain("working on it");
    // The text rendering is unchanged, and still shortened.
    expect(listed?.output).toContain("11111111…");
    expect(listed?.output).not.toContain(fullId);
  });

  it("is not steerable when the handle exists but the child has settled", async () => {
    // The runtime drops handles on settle, but a custom submitter may keep
    // them; either way a settled child must not advertise live controls.
    const submitter = {
      submit: async () => {
        throw new Error("unused");
      },
      listSubagents: () => [
        {
          sessionId: "done-child",
          capabilityTag: "test",
          objective: "finished",
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "completed" as const,
        },
      ],
      getHandle: () =>
        ({
          id: "done-child",
          sessionId: "done-child",
          output: () => "all done",
          status: () => ({ status: "completed" }),
        }) as never,
    };
    const backend = createAgentSessionBackend({
      createAgent: () => fakeAgent(submitter),
    });
    const { sessionId } = await backend.createSession({});
    const listed = await backend.listSessionAgents?.({ sessionId });
    expect(listed?.agents?.[0]?.steerable).toBe(false);
    expect(listed?.agents?.[0]).not.toHaveProperty("outputPreview");
  });

  it("marks a child with no live handle as not steerable", async () => {
    const submitter = {
      submit: async () => {
        throw new Error("unused");
      },
      listSubagents: () => [
        {
          sessionId: "settled-child",
          capabilityTag: "test",
          objective: "done already",
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "completed" as const,
        },
      ],
    };
    const backend = createAgentSessionBackend({
      createAgent: () => fakeAgent(submitter),
    });
    const { sessionId } = await backend.createSession({});
    const listed = await backend.listSessionAgents?.({ sessionId });
    expect(listed?.agents?.[0]?.steerable).toBe(false);
  });
});

describe("createAgentSessionBackend: agent control", () => {
  function makeHandle(sent: string[], state: { interrupted: boolean }) {
    return {
      id: "child-1",
      sessionId: "child-1",
      send: async (m: string) => {
        sent.push(m);
      },
      interrupt: (reason?: string) => {
        state.interrupted = true;
        void reason;
      },
      close: () => undefined,
      output: () => "",
      waitSettle: async () => ({}) as never,
      status: () => ({
        sessionId: "child-1",
        capabilityTag: "test",
        objective: "do a thing",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "running" as const,
      }),
    } as unknown as ContinuableSubagentHandle;
  }

  it("steers a live child and reports a settled one as a structured miss", async () => {
    const sent: string[] = [];
    const state = { interrupted: false };
    const handle = makeHandle(sent, state);
    const submitter = {
      submit: async () => {
        throw new Error("unused");
      },
      getHandle: (id: string) => (id === "child-1" ? handle : undefined),
      listSubagents: () => [],
    };
    const backend = createAgentSessionBackend({
      createAgent: () => fakeAgent(submitter),
    });
    const { sessionId } = await backend.createSession({});

    expect(
      await backend.sendAgentMessage?.({
        sessionId,
        agentId: "child-1",
        message: "go",
      }),
    ).toEqual({ queued: true, status: "running" });
    expect(sent).toEqual(["go"]);

    // A child that settled between the UI listing it and the user
    // clicking is a normal miss, not a thrown error.
    const missed = await backend.sendAgentMessage?.({
      sessionId,
      agentId: "gone",
      message: "hello?",
    });
    expect(missed).toMatchObject({ queued: false, status: "unknown" });
    expect(missed?.error).toContain("gone");

    expect(
      await backend.interruptAgent?.({
        sessionId,
        agentId: "child-1",
        reason: "stop",
      }),
    ).toEqual({ interrupted: true, status: "running" });
    expect(state.interrupted).toBe(true);
  });
});
