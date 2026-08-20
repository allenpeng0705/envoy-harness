/**
 * Phase 8 / Step 3 — `relay-status` B-class skill tests.
 *
 * **Acceptance:**
 * 1. Empty deps (no snapshot) → safe default with hint
 * 2. Valid snapshot → expected text + JSON output
 * 3. Edge case: empty relay book
 * 4. Edge case: empty recent traces
 * 5. Edge case: warnings populated
 * 6. Limit truncates the relay book / recent traces
 * 7. `buildRelayStatusTool` returns valid text
 * 8. `buildRelayStatusTool` `format='json'` returns JSON
 * 9. `buildRelayStatusTool` `parameters` schema validates input
 * 10. Snapshot: same text as the host's dev-CLI impl
 *     (`apps/node/src/developer-cli.ts:910`).
 *
 * **Why these tests are hermetic:** the bridge
 * doesn't touch the file system; the deps are
 * injected. Tests pass a fixed snapshot; no need
 * to set up a real `@envoymesh/local-store`.
 */

import { describe, expect, it } from "vitest";

import {
  relayStatusBridge,
  buildRelayStatusTool,
  type BClassRelaySnapshot,
  type BClassRelayStatusDeps,
} from "../../src/b-class-skills/relay-status.js";
import type { BClassAuditEventLike } from "../../src/b-class-skills/peer-list.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fully-populated snapshot for the test. */
function makeFullSnapshot(): BClassRelaySnapshot {
  return {
    generatedAt: "2026-08-20T18:00:00Z",
    source: "runtime",
    relay: {
      peerId: "12D3KooWRelay",
      enabled: true,
      relayServerEnabled: true,
      listenAddrs: ["/ip4/0.0.0.0/tcp/4001", "/ip6/::/tcp/4001"],
      uptimeMs: 3600000,
    },
    roster: {
      total: 42,
      fresh: 30,
      stale: 12,
      topCapabilities: [
        { capability: "agent.card", count: 20 },
        { capability: "vault.search", count: 5 },
      ],
      topTopics: [
        { topicHash: "abc123", count: 8 },
        { topicHash: "def456", count: 3 },
      ],
    },
    relayBook: {
      total: 5,
      byRelation: { direct: 2, transitive: 3 },
      byState: { fresh: 4, stale: 1 },
      neighbors: [
        { relayId: "relay-1", relation: "direct", state: "fresh", addrs: ["/ip4/1.2.3.4/tcp/4001"], failureCount: 0 },
        { relayId: "relay-2", relation: "transitive", state: "stale", addrs: ["/ip4/5.6.7.8/tcp/4001"], failureCount: 2 },
      ],
    },
    summaries: { total: 15, fresh: 10, stale: 5 },
    health: {
      status: "healthy",
      recoveryCounters: { healthChecks: 100, degraded: 2, unhealthy: 0, critical: 0 },
      actions: [],
      reasons: [],
    },
    routing: {
      forwardedLookupCount: 50,
      duplicateQueryDropCount: 3,
      negativeCacheSize: 5,
      selectedForwardTargetCount: 40,
      failedForwardCount: 1,
      collectedForwardResponseCount: 35,
      recentTraces: [
        { createdAt: "2026-08-20T17:59:00Z", protocol: "libp2p", remotePeerId: "12D3KooWA", summary: "lookup routed" },
        { createdAt: "2026-08-20T17:58:00Z", protocol: "libp2p", remotePeerId: "12D3KooWB", summary: "lookup routed" },
      ],
    },
    warnings: [],
  };
}

function makeDeps(
  snapshot: BClassRelaySnapshot | null | undefined,
  overrides?: Partial<BClassRelayStatusDeps>,
): BClassRelayStatusDeps {
  return {
    readAuditEvents: async () => [] as BClassAuditEventLike[],
    loadProfile: async () => ({}),
    buildSnapshot: () => snapshot,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("relayStatusBridge (Phase 8 / Step 3 — relay-status B-class skill)", () => {
  describe("empty / no-snapshot cases", () => {
    it("returns the empty-snapshot hint when buildSnapshot returns null", async () => {
      const result = await relayStatusBridge(makeDeps(null));
      expect(result.text).toContain("Relay manager status");
      expect(result.text).toContain("source=empty");
      expect(result.text).toContain("hint: no relay.manager.snapshot");
      expect(result.json).toContain('"source": "empty"');
      expect(result.snapshot).toBeNull();
    });

    it("returns the empty-snapshot hint when buildSnapshot returns undefined", async () => {
      const result = await relayStatusBridge(makeDeps(undefined));
      expect(result.text).toContain("source=empty");
    });
  });

  describe("valid snapshot", () => {
    it("formats the text output matching the dev-CLI format", async () => {
      const result = await relayStatusBridge(makeDeps(makeFullSnapshot()));
      // Mirrors `apps/node/src/developer-cli.ts:920-952`.
      const expectedLines = [
        "Relay manager status",
        "source=runtime generatedAt=2026-08-20T18:00:00Z",
        "peerId=12D3KooWRelay relay=true relayServer=true listenAddrs=2",
        "roster total=42 fresh=30 stale=12",
        "relayBook total=5 relations=direct=2 transitive=3 states=fresh=4 stale=1",
        "summaries total=15 fresh=10 stale=5",
        "health status=healthy checks=100 degraded=2 unhealthy=0 critical=0 actions=-",
        "routing forwarded=50 duplicates=3 negativeCache=5 selectedTargets=40 failedForwards=1 collectedResponses=35",
        "topCapabilities=agent.card:20,vault.search:5",
        "topTopics=abc123:8,def456:3",
        "",
        "Relay neighbors:",
        "relay-1 relation=direct state=fresh addrs=1 failures=0",
        "relay-2 relation=transitive state=stale addrs=1 failures=2",
        "",
        "Recent relay traces:",
        "2026-08-20T17:59:00Z libp2p 12D3KooWA lookup routed",
        "2026-08-20T17:58:00Z libp2p 12D3KooWB lookup routed",
      ];
      expect(result.text).toBe(expectedLines.join("\n"));
    });

    it("returns the JSON format with the raw snapshot", async () => {
      const result = await relayStatusBridge(makeDeps(makeFullSnapshot()));
      const parsed = JSON.parse(result.json);
      expect(parsed.source).toBe("runtime");
      expect(parsed.relay.peerId).toBe("12D3KooWRelay");
      expect(parsed.roster.total).toBe(42);
    });
  });

  describe("edge cases", () => {
    it("shows (none yet) for empty relay book", async () => {
      const snapshot = makeFullSnapshot();
      snapshot.relayBook!.neighbors = [];
      const result = await relayStatusBridge(makeDeps(snapshot));
      expect(result.text).toContain("Relay neighbors:");
      expect(result.text).toContain("(none yet)");
    });

    it("shows (none yet) for empty recent traces", async () => {
      const snapshot = makeFullSnapshot();
      snapshot.routing!.recentTraces = [];
      const result = await relayStatusBridge(makeDeps(snapshot));
      expect(result.text).toContain("Recent relay traces:");
      expect(result.text).toContain("(none yet)");
    });

    it("appends warnings as 'warning ...' lines", async () => {
      const snapshot = makeFullSnapshot();
      snapshot.warnings = ["relay-rpc high latency", "peer unreachable"];
      const result = await relayStatusBridge(makeDeps(snapshot));
      expect(result.text).toContain("warning relay-rpc high latency");
      expect(result.text).toContain("warning peer unreachable");
    });

    it("appends health reasons as 'healthReason ...' lines", async () => {
      const snapshot = makeFullSnapshot();
      snapshot.health!.reasons = ["degraded-peer: 12D3KooWX"];
      const result = await relayStatusBridge(makeDeps(snapshot));
      expect(result.text).toContain("healthReason degraded-peer: 12D3KooWX");
    });
  });

  describe("limits", () => {
    it("truncates relay neighbors to the limit", async () => {
      const snapshot = makeFullSnapshot();
      snapshot.relayBook!.neighbors = [];
      for (let i = 0; i < 10; i++) {
        snapshot.relayBook!.neighbors.push({
          relayId: `relay-${i}`,
          relation: "direct",
          state: "fresh",
          addrs: [],
          failureCount: 0,
        });
      }
      const result = await relayStatusBridge(makeDeps(snapshot, { limit: 3 }));
      // Only 3 neighbors should be in the output.
      const neighborLines = result.text
        .split("\n")
        .filter((l) => l.startsWith("relay-") && l.includes("relation=direct"));
      expect(neighborLines.length).toBe(3);
    });

    it("truncates recent traces to the limit (last N)", async () => {
      const snapshot = makeFullSnapshot();
      snapshot.routing!.recentTraces = [];
      for (let i = 0; i < 10; i++) {
        snapshot.routing!.recentTraces.push({
          createdAt: new Date(2026, 7, 20, 17, i).toISOString(),
          protocol: "libp2p",
          remotePeerId: `peer-${i}`,
          summary: "lookup",
        });
      }
      const result = await relayStatusBridge(makeDeps(snapshot, { limit: 3 }));
      const traceLines = result.text
        .split("\n")
        .filter((l) => l.includes("libp2p peer-"));
      // The last 3 traces (peer-7, peer-8, peer-9) should
      // be present, not the first 3.
      expect(traceLines.length).toBe(3);
      expect(traceLines[traceLines.length - 1]).toContain("peer-9");
    });
  });

  describe("buildRelayStatusTool (the BUILTIN tool shape)", () => {
    it("returns text format by default", async () => {
      const tool = buildRelayStatusTool(makeDeps(makeFullSnapshot()));
      const result = await tool.execute(
        { format: undefined, limit: undefined },
        {
          cwd: "/tmp",
          session: {} as never,
          abortSignal: new AbortController().signal,
        },
      );
      expect(result.content).toContain("Relay manager status");
      expect(result.content).toContain("peerId=12D3KooWRelay");
    });

    it("returns JSON format when format='json'", async () => {
      const tool = buildRelayStatusTool(makeDeps(makeFullSnapshot()));
      const result = await tool.execute(
        { format: "json", limit: undefined },
        {
          cwd: "/tmp",
          session: {} as never,
          abortSignal: new AbortController().signal,
        },
      );
      const parsed = JSON.parse(result.content as string);
      expect(parsed.source).toBe("runtime");
    });

    it("has a valid parameters schema (format + limit are optional)", () => {
      const tool = buildRelayStatusTool(makeDeps(null));
      // Valid: no params
      expect(tool.parameters.safeParse({}).success).toBe(true);
      // Valid: format + limit
      expect(
        tool.parameters.safeParse({ format: "text", limit: 5 }).success,
      ).toBe(true);
      // Invalid: unknown format
      expect(
        tool.parameters.safeParse({ format: "xml" }).success,
      ).toBe(false);
      // Invalid: negative limit
      expect(
        tool.parameters.safeParse({ limit: -1 }).success,
      ).toBe(false);
    });

    it("exposes the right name + description", () => {
      const tool = buildRelayStatusTool(makeDeps(null));
      expect(tool.name).toBe("relay_status");
      expect(tool.description).toMatch(/relay manager/i);
    });
  });
});
