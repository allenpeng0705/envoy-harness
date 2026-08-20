/**
 * Phase 8 / Step 3 — `peer-list` B-class skill tests.
 *
 * **Acceptance (per the Step 3 sub-plan §3.5):**
 * 1. Empty deps (no events) → safe default
 * 2. Valid events → expected output
 * 3. Malformed events → no throw, filtered gracefully
 * 4. Edge case: 0 events
 * 5. Edge case: large limit (no truncation)
 * 6. Edge case: events without `remotePeerId` (skipped)
 * 7. `p2p.trace` filtering (`includeP2pTraceInAudit`)
 * 8. `listPeersTool` returns valid text
 * 9. `listPeersTool` `parameters` schema validates input
 * 10. Snapshot: same output as the host's dev-CLI impl
 *     (`apps/node/src/developer-cli.ts:756`).
 *
 * **Why these tests are hermetic:** the bridge
 * doesn't touch the file system; the `readAuditEvents`
 * callback is injected. Tests pass a fixed event
 * list; no need to set up a real `@envoymesh/local-store`.
 */

import { describe, expect, it } from "vitest";

import {
  listPeersBridge,
  listPeersTool,
  type BClassAuditEventLike,
  type BClassPeerListDeps,
} from "../../src/b-class-skills/peer-list.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a fixed set of audit events. The `type` +
 * `createdAt` + `remotePeerId?` are the only fields
 * the bridge reads; extras are ignored.
 */
function makeFixtureEvents(): BClassAuditEventLike[] {
  return [
    { type: "message.sent", createdAt: "2026-08-20T10:00:00Z", remotePeerId: "12D3KooWA" },
    { type: "message.sent", createdAt: "2026-08-20T10:01:00Z", remotePeerId: "12D3KooWA" },
    { type: "message.rejected", createdAt: "2026-08-20T10:02:00Z", remotePeerId: "12D3KooWB" },
    { type: "p2p.trace", createdAt: "2026-08-20T10:03:00Z", remotePeerId: "12D3KooWC" },
    { type: "task.handled", createdAt: "2026-08-20T10:04:00Z" /* no remotePeerId */ },
    { type: "message.verified", createdAt: "2026-08-20T10:05:00Z", remotePeerId: "12D3KooWA" },
    { type: "p2p.trace", createdAt: "2026-08-20T10:06:00Z", remotePeerId: "12D3KooWB" },
  ];
}

/** Standard deps for tests. Override individual fields per case. */
function makeDeps(
  events: ReadonlyArray<BClassAuditEventLike>,
  overrides?: Partial<BClassPeerListDeps>,
): BClassPeerListDeps {
  return {
    readAuditEvents: async () => events,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listPeersBridge (Phase 8 / Step 3 — peer-list B-class skill)", () => {
  describe("empty inputs", () => {
    it("returns an empty result when there are no events", async () => {
      const result = await listPeersBridge(makeDeps([]));
      expect(result.total).toBe(0);
      expect(result.entries).toEqual([]);
      expect(result.text).toBe("Observed peers (0)");
    });
  });

  describe("valid events", () => {
    it("aggregates by remotePeerId with count + lastSeenAt", async () => {
      const result = await listPeersBridge(makeDeps(makeFixtureEvents()));
      // Fixture has 7 events: A appears 3 times, B 2 times
      // (1 message + 1 p2p.trace), C once (p2p.trace).
      // p2p.trace is filtered out by default, so:
      // - A: 3 events (message.sent, message.sent, message.verified)
      // - B: 1 event (message.rejected; the p2p.trace is dropped)
      // - C: 0 events (only event is a p2p.trace, dropped)
      // - (no remotePeerId): 0 entries
      // → total = 2 (A + B), entries = [A, B] sorted by lastSeen desc
      expect(result.total).toBe(2);
      expect(result.entries.length).toBe(2);

      // Sorted by lastSeenAt desc.
      expect(result.entries[0]).toEqual({
        peerId: "12D3KooWA",
        count: 3,
        lastSeenAt: "2026-08-20T10:05:00Z",
      });
      expect(result.entries[1]!).toEqual({
        peerId: "12D3KooWB",
        count: 1,
        lastSeenAt: "2026-08-20T10:02:00Z",
      });
    });

    it("formats the text output matching the dev-CLI format", async () => {
      const result = await listPeersBridge(makeDeps(makeFixtureEvents()));
      // Mirrors `apps/node/src/developer-cli.ts:756` output.
      const expectedLines = [
        "Observed peers (2)",
        "2026-08-20T10:05:00Z 12D3KooWA messages=3",
        "2026-08-20T10:02:00Z 12D3KooWB messages=1",
      ];
      expect(result.text).toBe(expectedLines.join("\n"));
    });
  });

  describe("filters", () => {
    it("drops events without remotePeerId (local events)", async () => {
      const events: BClassAuditEventLike[] = [
        { type: "task.handled", createdAt: "2026-08-20T10:00:00Z" },
        { type: "policy.decided", createdAt: "2026-08-20T10:01:00Z" },
        { type: "message.sent", createdAt: "2026-08-20T10:02:00Z", remotePeerId: "12D3KooWA" },
      ];
      const result = await listPeersBridge(makeDeps(events));
      expect(result.total).toBe(1);
      expect(result.entries[0]!.peerId).toBe("12D3KooWA");
    });

    it("drops p2p.trace events by default (includeP2pTraceInAudit=false)", async () => {
      const events: BClassAuditEventLike[] = [
        { type: "p2p.trace", createdAt: "2026-08-20T10:00:00Z", remotePeerId: "12D3KooWA" },
      ];
      const result = await listPeersBridge(makeDeps(events));
      expect(result.total).toBe(0);
    });

    it("includes p2p.trace events when includeP2pTraceInAudit=true", async () => {
      const events: BClassAuditEventLike[] = [
        { type: "p2p.trace", createdAt: "2026-08-20T10:00:00Z", remotePeerId: "12D3KooWA" },
      ];
      const result = await listPeersBridge(
        makeDeps(events, { includeP2pTraceInAudit: true }),
      );
      expect(result.total).toBe(1);
      expect(result.entries[0]!.peerId).toBe("12D3KooWA");
    });
  });

  describe("limits", () => {
    it("truncates to the limit (default 50)", async () => {
      // 100 distinct peers
      const events: BClassAuditEventLike[] = [];
      for (let i = 0; i < 100; i++) {
        events.push({
          type: "message.sent",
          createdAt: new Date(2026, 7, 20, 10, i).toISOString(),
          remotePeerId: `peer-${i.toString().padStart(3, "0")}`,
        });
      }
      const result = await listPeersBridge(makeDeps(events));
      // `total` reflects the FULL count (before truncation).
      expect(result.total).toBe(100);
      // `entries` is truncated to the default limit.
      expect(result.entries.length).toBe(50);
      // Most recent peer first.
      expect(result.entries[0]!.peerId).toBe("peer-099");
    });

    it("honors a custom limit", async () => {
      const events: BClassAuditEventLike[] = [];
      for (let i = 0; i < 10; i++) {
        events.push({
          type: "message.sent",
          createdAt: new Date(2026, 7, 20, 10, i).toISOString(),
          remotePeerId: `peer-${i}`,
        });
      }
      const result = await listPeersBridge(makeDeps(events, { limit: 3 }));
      expect(result.total).toBe(10);
      expect(result.entries.length).toBe(3);
    });
  });

  describe("listPeersTool (the BUILTIN tool shape)", () => {
    it("returns formatted text in the execute() result", async () => {
      const tool = listPeersTool(makeDeps(makeFixtureEvents()));
      const result = await tool.execute({ limit: undefined }, {
        cwd: "/tmp",
        session: {} as never,
        abortSignal: new AbortController().signal,
      });
      // Same as the bridge's test: 2 peers (A + B), C dropped (p2p.trace).
      expect(result.content).toContain("Observed peers (2)");
      expect(result.content).toContain("12D3KooWA");
      expect(result.content).toContain("12D3KooWB");
    });

    it("has a valid parameters schema (limit is optional positive int)", () => {
      const tool = listPeersTool(makeDeps([]));
      // Valid: no limit
      expect(tool.parameters.safeParse({}).success).toBe(true);
      expect(tool.parameters.safeParse({ limit: 5 }).success).toBe(true);
      // Invalid: negative limit
      expect(tool.parameters.safeParse({ limit: -1 }).success).toBe(false);
      // Invalid: non-integer
      expect(tool.parameters.safeParse({ limit: 1.5 }).success).toBe(false);
    });

    it("exposes the right name + description (model sees these in the system prompt)", () => {
      const tool = listPeersTool(makeDeps([]));
      expect(tool.name).toBe("list_peers");
      expect(tool.description).toMatch(/observed peers/i);
    });
  });
});
