/**
 * R7.2 — mesh vs cluster formatters.
 */

import { describe, expect, it } from "vitest";

import {
  formatCluster,
  formatMesh,
  formatPeers,
  formatScoreboard,
  formatTeamJobs,
  peerLabel,
} from "../src/ehui-format.js";

describe("peerLabel", () => {
  it("formats id alone", () => {
    expect(peerLabel({ id: "w1" })).toBe("w1");
  });

  it("appends model and capabilities", () => {
    expect(
      peerLabel({
        id: "w1",
        model: "gpt",
        capabilities: ["code", "research"],
      }),
    ).toBe("w1 gpt caps=code,research");
  });
});

describe("formatMesh", () => {
  it("is an onboarding guide distinct from cluster", () => {
    const text = formatMesh({ connected: 1, failed: 0 });
    expect(text).toContain("Mesh — collaborate");
    expect(text).toContain("Quick start");
    expect(text).toContain("Live status: connected 1");
    expect(text).not.toContain("health: ok");
    expect(text).not.toContain("Configured endpoints:");
  });

  it("lists configured endpoints only when provided", () => {
    const text = formatMesh({
      configuredPeers: [{ id: "w1", endpoint: "127.0.0.1:18123" }],
    });
    expect(text).toContain("Configured endpoints:");
    expect(text).toContain("w1 → 127.0.0.1:18123");
  });
});

describe("formatCluster", () => {
  it("lists peer health and routing hint", () => {
    const text = formatCluster({
      connected: 1,
      failed: 0,
      peers: [
        {
          id: "w1",
          model: "gpt",
          health: { ok: true, rttMs: 12 },
        },
      ],
    });
    expect(text).toContain("Cluster · connected 1");
    expect(text).toContain("health: ok rtt=12ms");
    expect(text).toContain("routing:");
  });

  it("includes route previews when provided", () => {
    const text = formatCluster(
      {
        connected: 1,
        failed: 0,
        peers: [{ id: "w1", health: { ok: true } }],
      },
      [{ tag: "code", peer: { id: "w1", model: "m" } }],
    );
    expect(text).toContain("code → w1 m");
  });
});

describe("formatPeers / team / scoreboard", () => {
  it("counts empty peers", () => {
    expect(formatPeers([])).toContain("Peers (0)");
  });

  it("formats team agents", () => {
    const text = formatTeamJobs([
      {
        jobId: "j1",
        status: "running",
        createdAt: "t0",
        agents: [
          { id: "a1", host: "local", status: "running", model: "m" },
        ],
      },
    ]);
    expect(text).toContain("Team (1)");
    expect(text).toContain("a1 @ local m = running");
  });

  it("formats scoreboard rows", () => {
    const text = formatScoreboard([
      {
        workerPeerId: "w1",
        skillId: "code",
        score: 0.9,
        passCount: 1,
        failCount: 0,
        partialCount: 0,
      },
    ]);
    expect(text).toContain("Scoreboard");
    expect(text).toContain("w1 · code");
  });
});
