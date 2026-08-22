/**
 * Hermetic TUI tests — in-process ACP, no TTY.
 */

import { describe, expect, it, vi } from "vitest";

import { createFakeSessionBackend } from "@envoymesh/envoy-harness";

import { createInProcessTui } from "../src/in-process.js";
import { parseSlash } from "../src/slash.js";
import { runInteractive } from "../src/ui.js";

describe("parseSlash", () => {
  it("recognizes help / cancel / quit", () => {
    expect(parseSlash("/help")?.kind).toBe("help");
    expect(parseSlash("/cancel")?.kind).toBe("cancel");
    expect(parseSlash("/quit")?.kind).toBe("quit");
    expect(parseSlash("hello")).toBeNull();
  });
});

describe("TuiSession via in-process ACP", () => {
  it("starts, prompts, and records transcript", async () => {
    const tui = createInProcessTui();
    await tui.session.start();
    expect(tui.session.sessionId).toMatch(/^sess-/);

    const result = await tui.session.submit("hello");
    expect(result).toBe("ok");
    const text = tui.session.renderTranscript();
    expect(text).toContain("[you] hello");
    expect(text).toContain("[agent] echo:hello");
    expect(text).toContain("stop: end_turn");
    tui.close();
  });

  it("handles /help and /quit", async () => {
    const tui = createInProcessTui();
    await tui.session.start();
    await tui.session.submit("/help");
    expect(tui.session.renderTranscript()).toContain("/cancel");
    expect(tui.session.renderTranscript()).toContain("/peers");
    expect(await tui.session.submit("/quit")).toBe("quit");
    tui.close();
  });

  it("/peers renders the host's connected peer cluster", async () => {
    const tui = createInProcessTui({
      backend: createFakeSessionBackend({
        peers: [
          { id: "p1", model: "deepseek-chat" },
          { id: "p2", capabilities: ["research"] },
        ],
      }),
    });
    await tui.session.start();
    await tui.session.submit("/peers");
    const text = tui.session.renderTranscript();
    expect(text).toContain("Peers (2)");
    expect(text).toContain("- p1 model=deepseek-chat");
    expect(text).toContain("- p2 capabilities=research");
    tui.close();
  });

  it("/peers shows an empty state when no peers are connected", async () => {
    const tui = createInProcessTui();
    await tui.session.start();
    await tui.session.submit("/peers");
    expect(tui.session.renderTranscript()).toContain("Peers (0)");
    tui.close();
  });

  it("/cluster renders peer health and totals", async () => {
    const tui = createInProcessTui({
      backend: createFakeSessionBackend({
        clusterStatus: {
          peers: [
            {
              id: "p1",
              model: "deepseek-chat",
              health: { ok: true, rttMs: 12 },
            },
            {
              id: "p2",
              health: { ok: false, error: "connect refused" },
            },
          ],
          connected: 1,
          failed: 1,
        },
      }),
    });
    await tui.session.start();
    await tui.session.submit("/cluster");
    const text = tui.session.renderTranscript();
    expect(text).toContain("Cluster (2 connected=1 failed=1)");
    expect(text).toContain("- p1 model=deepseek-chat ok rtt=12ms");
    expect(text).toContain("- p2 down (connect refused)");
    tui.close();
  });

  it("/team renders jobs and /scoreboard renders reputation", async () => {
    const tui = createInProcessTui({
      backend: createFakeSessionBackend({
        teamJobs: [
          {
            jobId: "job-1",
            status: "running",
            createdAt: "2026-08-23T00:00:00.000Z",
            agents: [
              {
                id: "a1",
                host: "peer://p1",
                model: "deepseek-chat",
                status: "running",
              },
            ],
          },
        ],
        scoreboard: [
          {
            workerPeerId: "p1",
            skillId: "research",
            score: 0.9,
            passCount: 9,
            failCount: 1,
            partialCount: 0,
          },
        ],
        discoveryEvents: [
          {
            type: "peer.connected",
            peerId: "p1",
            at: "2026-08-23T00:00:00.000Z",
          },
        ],
      }),
    });
    await tui.session.start();
    await tui.session.submit("/team");
    expect(tui.session.renderTranscript()).toContain("job-1 running");
    expect(tui.session.renderTranscript()).toContain("a1@peer://p1=running");
    await tui.session.submit("/scoreboard");
    expect(tui.session.renderTranscript()).toContain(
      "- p1 research score=0.9 pass=9 fail=1 partial=0",
    );
    tui.close();
  });

  it("routes permission via onPermission", async () => {
    const decisions: string[] = [];
    const tui = createInProcessTui({
      backend: createFakeSessionBackend({ permissionTool: "bash" }),
      onPermission: async (req) => {
        decisions.push(req.toolName);
        return "allow";
      },
    });
    await tui.session.start();
    await tui.session.submit("run");
    expect(decisions).toEqual(["bash"]);
    expect(tui.session.renderTranscript()).toContain("echo:run");
    tui.close();
  });

  it("/cancel records status", async () => {
    const tui = createInProcessTui();
    await tui.session.start();
    await tui.session.submit("/cancel");
    expect(tui.session.renderTranscript()).toContain("cancelled");
    tui.close();
  });

  it("buffers discovery events from a subscription", async () => {
    const tui = createInProcessTui({
      backend: createFakeSessionBackend({
        discoveryEvents: [
          {
            type: "peer.connected",
            peerId: "p1",
            at: "2026-08-23T00:00:00.000Z",
          },
        ],
      }),
    });
    await tui.session.start();
    const unsubscribe = await tui.session.subscribeDiscovery();
    expect(tui.session.discoveryEvents).toHaveLength(1);
    expect(tui.session.discoveryEvents[0]).toMatchObject({
      type: "peer.connected",
      peerId: "p1",
    });
    unsubscribe();
    tui.close();
  });
});

describe("TuiSession via attached CLI --acp pipes", () => {
  it("talks to run({ argv: ['--acp'] }) over PassThrough", async () => {
    const { PassThrough } = await import("node:stream");
    const { run } = await import("@envoymesh/envoy-harness");
    const { createAttachedTui } = await import("../src/attached.js");

    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const stderr = new PassThrough();
    const serverDone = run({
      argv: ["--acp", "--quiet"],
      stdin: c2s,
      stdout: s2c,
      stderr,
    });

    const tui = createAttachedTui({ input: s2c, output: c2s });
    await tui.session.start();
    expect(tui.session.sessionId).toMatch(/^sess-/);
    expect(await tui.session.submit("hello")).toBe("ok");
    expect(tui.session.renderTranscript()).toMatch(/echo:hello/);
    tui.close();
    c2s.end();
    await serverDone;
  });
});

describe("runInteractive screen mode (raw keypress input)", () => {
  it("composes, submits, renders the transcript, and quits via /quit", async () => {
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

    const tui = createInProcessTui();
    const done = runInteractive({
      session: tui.session,
      input,
      output,
      interactive: true,
      width: 60,
      height: 8,
    });

    // Wait for the keypress listener to attach, then drive raw keys.
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const ch of "hello") input.write(ch);
    input.write("\r");
    await vi.waitFor(() => {
      expect(tui.session.renderTranscript()).toContain("echo:hello");
    });
    for (const ch of "/quit") input.write(ch);
    input.write("\r");
    await done;

    const text = chunks.join("");
    // The composer input and the echoed transcript made it into the render.
    expect(text).toContain("hello");
    expect(text).toContain("echo:hello");
    tui.close();
  });

  it("switches to detail views and Esc returns to chat", async () => {
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

    const tui = createInProcessTui({
      backend: createFakeSessionBackend({
        clusterStatus: {
          peers: [
            {
              id: "p1",
              model: "deepseek-chat",
              health: { ok: true, rttMs: 12 },
            },
          ],
          connected: 1,
          failed: 0,
        },
        routePeer: (input) =>
          input.capabilityTag === "research"
            ? { id: "p1", model: "deepseek-chat" }
            : undefined,
        scoreboard: [
          {
            workerPeerId: "p1",
            skillId: "research",
            score: 0.9,
            passCount: 9,
            failCount: 1,
            partialCount: 0,
          },
        ],
        discoveryEvents: [
          {
            type: "peer.connected",
            peerId: "p1",
            at: "2026-08-23T00:00:00.000Z",
          },
        ],
      }),
    });
    const done = runInteractive({
      session: tui.session,
      input,
      output,
      interactive: true,
      width: 70,
      height: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const type = async (text: string): Promise<void> => {
      for (const ch of text) input.write(ch);
      input.write("\r");
    };

    await type("/cluster");
    await vi.waitFor(() => {
      expect(chunks.join("")).toContain("Cluster · connected 1 / failed 0");
    });

    input.write("\x1b"); // Esc → back to chat
    await type("/route research");
    await vi.waitFor(() => {
      expect(chunks.join("")).toContain('Route "research" → p1 deepseek-chat');
    });

    await type("/search hello");
    await vi.waitFor(() => {
      expect(chunks.join("")).toContain('Search "hello"');
    });
    await type("/trace");
    await vi.waitFor(() => {
      expect(chunks.join("")).toContain("Trace (");
      expect(chunks.join("")).toContain("p1 connected");
    });

    await type("/quit");
    await done;
    tui.close();
  });
});
