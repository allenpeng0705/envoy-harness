/**
 * Dispatch wiring for `/project` and `/agents` through TuiSession.submit.
 * Hermetic: a fake EnvoyHarnessClient, no ACP, no TTY.
 */

import { describe, expect, it, vi } from "vitest";

import type {
  ClientWorkspaceEntry,
  EnvoyHarnessClient,
} from "@envoymesh/envoy-harness-client";

import { TuiSession } from "../src/session.js";

const ENTRIES: ClientWorkspaceEntry[] = [
  { path: "/p/one", name: "one", addedAt: "2026-01-01T00:00:00.000Z" },
  { path: "/p/two", name: "two", addedAt: "2026-01-01T00:00:00.000Z" },
];

function fakeClient(methods: Record<string, unknown>): EnvoyHarnessClient {
  return {
    onNotification: () => () => {},
    close: () => {},
    ...methods,
  } as unknown as EnvoyHarnessClient;
}

describe("TuiSession.submit — /project and /agents wiring", () => {
  it("lists projects and opens one by index via the workspace ctx", async () => {
    const acpNewSession = vi.fn(async () => ({ sessionId: "sess-new" }));
    const client = fakeClient({
      listWorkspaces: vi.fn(async () => ENTRIES),
      acpNewSession,
    });
    const session = new TuiSession({ client });

    await session.submit("/project list");
    expect(session.renderTranscript()).toContain("Projects (2)");
    expect(session.renderTranscript()).toContain("/p/two");

    await session.submit("/project open 2");
    expect(acpNewSession).toHaveBeenCalledWith({ cwd: "/p/two" });
    expect(session.sessionId).toBe("sess-new");
    const after = session.renderTranscript();
    expect(after).toContain("new session (project two) sess-new");
    expect(after).not.toContain("Projects (2)");
    session.close();
  });

  it("steers a child through /agents send and renders structured agents", async () => {
    const sendAgentMessage = vi.fn(async () => ({
      queued: true,
      status: "running",
    }));
    const client = fakeClient({
      listWorkspaces: vi.fn(async () => ENTRIES),
      acpNewSession: vi.fn(async () => ({ sessionId: "sess-1" })),
      sendAgentMessage,
      sessionAgents: vi.fn(async () => ({
        output: "text",
        agents: [
          {
            id: "agent-full-id-1234",
            capabilityTag: "research",
            objective: "dig",
            status: "running" as const,
            startedAt: "2026-01-01T00:00:00.000Z",
            steerable: true,
            outputPreview: "working",
          },
        ],
      })),
    });
    const session = new TuiSession({ client });

    await session.submit("/project open 1");
    await session.submit("/agents send agent-full-id-1234 please retry");
    expect(sendAgentMessage).toHaveBeenCalledWith(
      "sess-1",
      "agent-full-id-1234",
      "please retry",
    );
    expect(session.renderTranscript()).toContain("queued (running)");

    await session.submit("/agents");
    expect(session.renderTranscript()).toContain("agent-full-id-1234");
    expect(session.renderTranscript()).toContain("↳ working");
    session.close();
  });
});
