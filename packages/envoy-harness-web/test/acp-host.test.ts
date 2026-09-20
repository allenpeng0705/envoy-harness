/**
 * Hermetic tests for AcpHost + activity + discovery helper paths.
 */
import { describe, expect, it } from "vitest";
import { formatActivityLine } from "../src/client/acp/activity.js";
import {
  agentInterruptParams,
  agentMessageParams,
  requestAddWorkspace,
  requestRemoveWorkspace,
  requestWorkspaces,
  sessionNewParams,
  workspaceAddParams,
} from "../src/client/acp/host-control.js";
import { AcpHost } from "../src/client/acp/host.js";
import {
  fetchMeshSnapshot,
  parseMeshAgents,
} from "../src/client/acp/mesh-snapshot.js";
import type { WsJsonRpcClient } from "../src/client/acp/ws-jsonrpc.js";
import {
  groupSessionsByProject,
  projectLabel,
} from "../src/client/session-groups.js";
import type { SessionSummary } from "../src/client/acp/host-types.js";

describe("formatActivityLine", () => {
  it("formats tool_call and subagent prefix", () => {
    expect(
      formatActivityLine({
        kind: "tool_call",
        summary: "bash ls",
        toolName: "bash",
      }),
    ).toContain("bash ls");
    expect(
      formatActivityLine({
        kind: "tool_call",
        summary: "read",
        subagentOf: "parent",
      }),
    ).toMatch(/↳/);
  });

  it("skips model_response via empty string", () => {
    expect(
      formatActivityLine({ kind: "model_response", summary: "…" }),
    ).toBe("");
  });
});

describe("AcpHost", () => {
  it("starts idle / disconnected-ready false", () => {
    const host = new AcpHost();
    expect(host.state.connectionState).toBe("idle");
    expect(host.state.ready).toBe(false);
    expect(host.state.mesh).toBeNull();
    host.close();
    expect(host.state.connectionState).toBe("disconnected");
  });

  it("notifies subscribers", () => {
    const host = new AcpHost();
    let ticks = 0;
    const unsub = host.subscribe(() => {
      ticks += 1;
    });
    host.close();
    expect(ticks).toBeGreaterThan(0);
    unsub();
  });
});

describe("request shaping", () => {
  it("sends session/new with cwd only when non-empty", () => {
    expect(sessionNewParams()).toEqual({});
    expect(sessionNewParams(undefined)).toEqual({});
    expect(sessionNewParams("   ")).toEqual({});
    expect(sessionNewParams("/tmp/proj")).toEqual({ cwd: "/tmp/proj" });
    expect(sessionNewParams("  /tmp/proj  ")).toEqual({ cwd: "/tmp/proj" });
  });

  it("omits an empty workspace name", () => {
    expect(workspaceAddParams("/p")).toEqual({ path: "/p" });
    expect(workspaceAddParams("/p", "  ")).toEqual({ path: "/p" });
    expect(workspaceAddParams("/p", " My project ")).toEqual({
      path: "/p",
      name: "My project",
    });
  });

  it("shapes agent steering params, omitting an empty reason", () => {
    expect(agentMessageParams("s1", "child", "go")).toEqual({
      sessionId: "s1",
      agentId: "child",
      message: "go",
    });
    expect(agentInterruptParams("s1", "child")).toEqual({
      sessionId: "s1",
      agentId: "child",
    });
    expect(agentInterruptParams("s1", "child", "  ")).toEqual({
      sessionId: "s1",
      agentId: "child",
    });
    expect(agentInterruptParams("s1", "child", " wrong way ")).toEqual({
      sessionId: "s1",
      agentId: "child",
      reason: "wrong way",
    });
  });
});

describe("AcpHost disconnected workspace + steering", () => {
  it("lists no workspaces and rejects mutations when not connected", async () => {
    const host = new AcpHost();
    await expect(host.listWorkspaces()).resolves.toEqual([]);
    await expect(host.addWorkspace("/tmp/p")).rejects.toThrow("not connected");
    await expect(host.removeWorkspace("/tmp/p")).rejects.toThrow(
      "not connected",
    );
    host.close();
  });

  it("returns a structured miss (no throw) with no active session", async () => {
    const host = new AcpHost();
    await expect(host.sendAgentMessage("a", "hi")).resolves.toEqual({
      queued: false,
      status: "no-session",
      error: "no active session",
    });
    await expect(host.interruptAgent("a")).resolves.toEqual({
      interrupted: false,
      status: "no-session",
      error: "no active session",
    });
    host.close();
  });

  it("shapes the workspace RPC calls and returns their payloads", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = {
      request: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "workspace/list") {
          return { workspaces: [{ path: "/p", name: "p", addedAt: "t" }] };
        }
        if (method === "workspace/add") {
          return { workspace: { path: "/p2", name: "n", addedAt: "t" } };
        }
        if (method === "workspace/remove") return { removed: true };
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as WsJsonRpcClient;

    await expect(requestWorkspaces(client)).resolves.toEqual([
      { path: "/p", name: "p", addedAt: "t" },
    ]);
    await expect(requestAddWorkspace(client, "/p2", " n ")).resolves.toEqual({
      path: "/p2",
      name: "n",
      addedAt: "t",
    });
    await expect(requestRemoveWorkspace(client, "/p2")).resolves.toBe(true);
    await expect(requestWorkspaces(undefined)).resolves.toEqual([]);
    await expect(requestAddWorkspace(undefined, "/p2")).rejects.toThrow(
      "not connected",
    );
    expect(calls).toEqual([
      { method: "workspace/list", params: {} },
      { method: "workspace/add", params: { path: "/p2", name: "n" } },
      { method: "workspace/remove", params: { path: "/p2" } },
    ]);
  });
});

describe("groupSessionsByProject", () => {
  const summary = (
    id: string,
    cwd: string | undefined,
  ): SessionSummary => ({
    id,
    mtimeMs: 1,
    messageCount: 1,
    ...(cwd !== undefined ? { cwd } : {}),
  });

  it("groups by cwd, sorts projects, and puts unknown cwd last", () => {
    const groups = groupSessionsByProject([
      summary("a", "/work/beta"),
      summary("b", "/work/alpha"),
      summary("c", undefined),
      summary("d", "   "),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["alpha", "beta", "Other"]);
    expect(groups[0]?.cwd).toBe("/work/alpha");
    expect(groups[2]?.sessions.map((s) => s.id)).toEqual(["c", "d"]);
  });

  it("derives labels from paths", () => {
    expect(projectLabel("/work/alpha/")).toBe("alpha");
    expect(projectLabel("C:\\work\\alpha")).toBe("alpha");
    expect(projectLabel("")).toBe("Other");
    expect(projectLabel("/")).toBe("Other");
  });
});

describe("parseMeshAgents", () => {
  it("distinguishes an absent array from an empty one", () => {
    expect(parseMeshAgents(undefined)).toBeUndefined();
    expect(parseMeshAgents("nope")).toBeUndefined();
    expect(parseMeshAgents([])).toEqual([]);
  });

  it("normalizes untrusted rows and defaults steerable to false", () => {
    const parsed = parseMeshAgents([
      {
        id: "11111111-2222-3333-4444-555555555555",
        capabilityTag: "review",
        objective: "check it",
        status: "weird",
        startedAt: "2026-01-01T00:00:00.000Z",
        costUsd: 0.0123,
        steerable: "yes",
      },
      { objective: "no id" },
      null,
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.status).toBe("unknown");
    expect(parsed?.[0]?.steerable).toBe(false);
    expect(parsed?.[0]?.costUsd).toBe(0.0123);
  });

  it("carries a running child's live output preview, and omits an empty one", () => {
    const parsed = parseMeshAgents([
      {
        id: "a",
        status: "running",
        steerable: true,
        outputPreview: "thinking about it",
      },
      { id: "b", status: "running", steerable: true, outputPreview: "" },
      { id: "c", status: "running", steerable: true },
    ]);
    expect(parsed?.[0]?.outputPreview).toBe("thinking about it");
    expect(parsed?.[1]).not.toHaveProperty("outputPreview");
    expect(parsed?.[2]).not.toHaveProperty("outputPreview");
  });
});

function stubClient(
  handlers: Record<string, (params: unknown) => unknown>,
): WsJsonRpcClient {
  return {
    request: async (method: string, params?: unknown) => {
      const handler = handlers[method];
      if (handler === undefined) throw new Error(`no stub for ${method}`);
      return handler(params);
    },
  } as unknown as WsJsonRpcClient;
}

describe("fetchMeshSnapshot structured agents", () => {
  const agents = [
    {
      id: "11111111-2222-3333-4444-555555555555",
      capabilityTag: "review",
      objective: "check it",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      steerable: true,
    },
  ];

  it("carries the full ids + steerable flag through", async () => {
    const client = stubClient({
      "cluster/status": () => ({
        cluster: {
          connected: 1,
          failed: 0,
          peers: [{ id: "p", health: { ok: true } }],
        },
      }),
      "team/jobs": () => ({ jobs: [] }),
      "session/agents": () => ({
        output: "sub-agents: 1 (1 running)",
        agents,
      }),
    });
    const { mesh } = await fetchMeshSnapshot(client, "s1", null, 0);
    expect(mesh.agents).toEqual(agents);
    expect(mesh.agentsSummary).toBe("sub-agents: 1 (1 running)");
  });

  it("leaves agents undefined when the host only sends output", async () => {
    const client = stubClient({
      "cluster/status": () => {
        throw new Error("unsupported");
      },
      "peers/list": () => {
        throw new Error("unsupported");
      },
      "team/jobs": () => ({ jobs: [] }),
      "session/agents": () => ({
        output: "no sub-agents spawned in this session",
      }),
    });
    const { mesh } = await fetchMeshSnapshot(client, "s1", null, 0);
    expect(mesh.agents).toBeUndefined();
    expect(mesh.agentsSummary).toBe("no sub-agents spawned in this session");
  });
});
