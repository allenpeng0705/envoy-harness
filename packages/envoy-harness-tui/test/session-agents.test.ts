/**
 * `/agents` handlers against a fake client — hermetic (no ACP, no TTY).
 * Covers the structured payload, the text fallback, and the control
 * calls' structured-error path (a normal miss, never a throw).
 */

import { describe, expect, it, vi } from "vitest";

import type { EnvoyHarnessClient } from "@envoymesh/envoy-harness-client";

import type { SessionSink } from "../src/session-context.js";
import { runAgentsImpl } from "../src/session-workspace.js";
import type { TranscriptRole } from "../src/transcript.js";
import { renderAgentsView } from "../src/views.js";

const RUNNING = {
  id: "agent-0123456789abcdef",
  capabilityTag: "research",
  objective: "investigate the flaky test",
  status: "running" as const,
  startedAt: "2026-01-01T00:00:00.000Z",
  costUsd: 0.12,
  durationMs: 4200,
  steerable: true,
  outputPreview: "line one\nline two with more detail",
};

interface Harness {
  sink: SessionSink;
  pushed: Array<{ role: TranscriptRole; text: string }>;
}

function harness(
  client: Record<string, unknown>,
  sessionId: string | undefined = "sess-1",
): Harness {
  const pushed: Array<{ role: TranscriptRole; text: string }> = [];
  const sink: SessionSink = {
    push: (role, text) => {
      pushed.push({ role, text });
    },
    client: client as unknown as EnvoyHarnessClient,
    sessionId,
    busy: false,
  };
  return { sink, pushed };
}

function text(h: Harness): string {
  return h.pushed.map((p) => p.text).join("\n");
}

describe("/agents list", () => {
  it("renders full ids, status, tag, cost/duration, and a one-line preview", async () => {
    const sessionAgents = vi.fn(async () => ({
      output: "text rendering",
      agents: [RUNNING],
    }));
    const h = harness({ sessionAgents });
    await runAgentsImpl(h.sink, "list");
    const out = text(h);
    expect(out).toContain("Agents (1)");
    expect(out).toContain("agent-0123456789abcdef");
    expect(out).toContain("running [research]");
    expect(out).toContain("cost=$0.12");
    expect(out).toContain("4200ms");
    expect(out).toContain("steerable");
    expect(out).toContain("investigate the flaky test");
    // Preview is collapsed to a single line.
    expect(out).toContain("↳ line one line two with more detail");
  });

  it("falls back to the text rendering and offers no steering", async () => {
    const sessionAgents = vi.fn(async () => ({
      output: "Agents (1)\n  agent-01 running",
    }));
    const h = harness({ sessionAgents });
    await runAgentsImpl(h.sink, "list");
    expect(text(h)).toContain("Agents (1)");
    expect(text(h)).toContain("agent-01 running");
    expect(text(h)).toContain("steering unavailable");
  });

  it("reports a client failure as a status line", async () => {
    const sessionAgents = vi.fn(async () => {
      throw new Error("session/agents not supported");
    });
    const h = harness({ sessionAgents });
    await expect(runAgentsImpl(h.sink, "list")).resolves.toBeUndefined();
    expect(text(h)).toContain("agents failed: session/agents not supported");
  });

  it("reports no active session", async () => {
    const h = harness({ sessionAgents: vi.fn() });
    h.sink.sessionId = undefined;
    await runAgentsImpl(h.sink, "list");
    expect(text(h)).toContain("no active session");
  });
});

describe("/agents send", () => {
  it("passes the full id and message and reports queued", async () => {
    const sendAgentMessage = vi.fn(async () => ({
      queued: true,
      status: "running",
    }));
    const h = harness({ sendAgentMessage });
    await runAgentsImpl(h.sink, "send", "agent-0123", "please retry");
    expect(sendAgentMessage).toHaveBeenCalledWith(
      "sess-1",
      "agent-0123",
      "please retry",
    );
    expect(text(h)).toContain("agent agent-0123: queued (running)");
  });

  it("renders a structured error as a status line without throwing", async () => {
    const sendAgentMessage = vi.fn(async () => ({
      queued: false,
      status: "unknown",
      error: "no continuable child 'agent-x' in this session",
    }));
    const h = harness({ sendAgentMessage });
    await expect(
      runAgentsImpl(h.sink, "send", "agent-x", "hello"),
    ).resolves.toBeUndefined();
    expect(text(h)).toContain(
      "agent send: no continuable child 'agent-x' in this session",
    );
    expect(text(h)).not.toContain("not queued");
  });
});

describe("/agents interrupt", () => {
  it("passes the id and reason and reports interrupted", async () => {
    const interruptAgent = vi.fn(async () => ({
      interrupted: true,
      status: "running",
    }));
    const h = harness({ interruptAgent });
    await runAgentsImpl(
      h.sink,
      "interrupt",
      "agent-0123",
      undefined,
      "user aborted",
    );
    expect(interruptAgent).toHaveBeenCalledWith(
      "sess-1",
      "agent-0123",
      "user aborted",
    );
    expect(text(h)).toContain("agent agent-0123: interrupted (running)");
  });

  it("renders a structured error as a status line without throwing", async () => {
    const interruptAgent = vi.fn(async () => ({
      interrupted: false,
      status: "unknown",
      error: "no continuable child 'agent-x' in this session",
    }));
    const h = harness({ interruptAgent });
    await expect(
      runAgentsImpl(h.sink, "interrupt", "agent-x"),
    ).resolves.toBeUndefined();
    expect(text(h)).toContain(
      "agent interrupt: no continuable child 'agent-x' in this session",
    );
  });
});

describe("renderAgentsView", () => {
  it("truncates a long preview to one line", () => {
    const long = "x".repeat(400);
    const lines = renderAgentsView([
      { ...RUNNING, outputPreview: long, objective: long },
    ]);
    const preview = lines.find((l) => l.startsWith("    ↳ "));
    expect(preview).toBeDefined();
    expect(preview?.length).toBeLessThan(130);
    expect(preview?.endsWith("…")).toBe(true);
    expect(lines.join("\n")).not.toContain("\n\n");
  });

  it("shows an empty state", () => {
    expect(renderAgentsView([])).toEqual(["Agents (0) — no sub-agents"]);
  });
});
