/**
 * U3 — detail-view renderers (pure, hermetic).
 */

import { describe, expect, it } from "vitest";

import {
  renderClusterView,
  renderDiscoveryTicker,
  renderPeersView,
  renderRouteView,
  renderScoreboardView,
  renderSearchView,
  renderTeamView,
  renderTraceView,
} from "../src/views.js";

describe("renderClusterView", () => {
  it("shows totals and per-peer health", () => {
    const lines = renderClusterView({
      peers: [
        {
          id: "p1",
          model: "deepseek-chat",
          capabilities: ["research"],
          health: { ok: true, rttMs: 12, lastPingAt: "2026-08-23T00:00:00.000Z" },
        },
        {
          id: "p2",
          health: { ok: false, error: "connect refused" },
        },
      ],
      connected: 1,
      failed: 1,
    });
    expect(lines.join("\n")).toContain("Cluster · connected 1 / failed 1");
    expect(lines.join("\n")).toContain("p1 deepseek-chat caps=research");
    expect(lines.join("\n")).toContain("health: ok rtt=12ms");
    expect(lines.join("\n")).toContain("health: down (connect refused)");
  });

  it("renders routing previews when provided", () => {
    const lines = renderClusterView(
      {
        peers: [
          {
            id: "p1",
            health: { ok: true },
            capabilities: ["research"],
          },
        ],
        connected: 1,
        failed: 0,
      },
      [
        { tag: "research", peer: { id: "p1", model: "deepseek-chat" } },
        { tag: "code", peer: undefined },
      ],
    );
    const text = lines.join("\n");
    expect(text).toContain("routing:");
    expect(text).toContain("research → p1 deepseek-chat");
    expect(text).toContain("code → no peer");
  });
});

describe("renderRouteView", () => {
  it("shows the routed peer or a no-peer state", () => {
    expect(
      renderRouteView({
        tag: "research",
        peer: { id: "p1", model: "deepseek-chat" },
      }).join("\n"),
    ).toBe('Route "research" → p1 deepseek-chat');
    expect(renderRouteView({ tag: "research", peer: undefined }).join("\n")).toBe(
      'Route "research" → no peer available',
    );
  });
});

describe("renderTeamView", () => {
  it("renders jobs with agent hosts and status", () => {
    const lines = renderTeamView([
      {
        jobId: "job-1",
        status: "running",
        createdAt: "2026-08-23T00:00:00.000Z",
        costUsd: 0.5,
        agents: [
          {
            id: "a1",
            host: "peer://p1",
            model: "deepseek-chat",
            status: "running",
          },
          { id: "a2", host: "local", status: "completed" },
        ],
      },
    ]);
    const text = lines.join("\n");
    expect(text).toContain("job-1 running cost=0.5");
    expect(text).toContain("a1 @ peer://p1 deepseek-chat = running");
    expect(text).toContain("a2 @ local = completed");
  });
});

describe("renderScoreboardView", () => {
  it("renders reputation entries", () => {
    const text = renderScoreboardView([
      {
        workerPeerId: "p1",
        skillId: "research",
        score: 0.9,
        passCount: 9,
        failCount: 1,
        partialCount: 0,
      },
    ]).join("\n");
    expect(text).toContain("Scoreboard (1)");
    expect(text).toContain("p1 research score=0.9 pass=9 fail=1 partial=0");
  });
});

describe("renderDiscoveryTicker", () => {
  it("shows the newest events first, newest up to max", () => {
    const lines = renderDiscoveryTicker(
      [
        {
          type: "peer.connected",
          peerId: "p1",
          at: "2026-08-23T00:00:00.000Z",
        },
        {
          type: "peer.failed",
          peerId: "p2",
          error: "connect refused",
          at: "2026-08-23T00:00:01.000Z",
        },
      ],
      3,
    );
    expect(lines).toEqual([
      "! p2 failed: connect refused",
      "! p1 connected",
    ]);
  });
});

describe("renderSearchView", () => {
  it("filters transcript lines case-insensitively with a count", () => {
    const lines = renderSearchView(
      ["[you] hello world", "[agent] HELLO again", "[you] nothing"],
      "hello",
    );
    expect(lines[0]).toBe('Search "hello" — 2 matches');
    expect(lines).toContain("  [you] hello world");
    expect(lines).toContain("  [agent] HELLO again");
    expect(renderSearchView(["a", "b"], "z")).toEqual([
      'Search "z" — no matches',
    ]);
  });
});

describe("renderTraceView", () => {
  it("renders the event log newest first", () => {
    const lines = renderTraceView([
      {
        type: "peer.connected",
        peerId: "p1",
        at: "2026-08-23T00:00:00.000Z",
      },
      {
        type: "peer.health",
        peerId: "p1",
        rttMs: 5,
        at: "2026-08-23T00:00:01.000Z",
      },
    ]);
    expect(lines[0]).toBe("Trace (2)");
    expect(lines[1]).toContain("p1 rtt=5ms");
    expect(lines[2]).toContain("p1 connected");
  });
});
