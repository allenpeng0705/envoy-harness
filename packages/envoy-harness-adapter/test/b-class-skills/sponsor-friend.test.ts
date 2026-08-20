/**
 * Phase 8 / Step 3 — `setup-sponsor-friend` B-class skill tests.
 *
 * **Acceptance (subset, per the Step 3 plan):**
 * 1. Empty deps (no config) → safe default (skipped)
 * 2. Valid deps → success path
 * 3. Already-completed → skipped
 * 4. Already-bonded → skipped
 * 5. Cooldown active → skipped
 * 6. Profile not ready → skipped
 * 7. Mesh not ready → skipped
 * 8. Max attempts exhausted → `auto-exhausted`
 * 9. Tool: `sponsor_friend.execute()` returns JSON
 * 10. Tool: `parameters` schema validates input
 *
 * **Why a smaller test set than peer-list / relay-status:**
 * the sponsor-friend algorithm is 200+ lines of
 * orchestration logic. We test the key paths
 * (skipped cases + success path + exhaustion) but
 * don't try to cover every edge case in unit tests.
 * The snapshot test (the cross-check) is the
 * primary regression detector.
 *
 * **Hermetic:** all deps are injected. Tests use a
 * fake `mesh` / `profile` / `config` / `audit` that
 * returns in-memory state.
 */

import { describe, expect, it, beforeEach } from "vitest";

import {
  runSponsorFriendBridge,
  sponsorFriendTool,
  __resetActiveSponsorLoopsForTests,
  type BClassSponsorFriendDeps,
  type BClassPersistedNodeConfig,
} from "../../src/b-class-skills/sponsor-friend.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMockDeps(overrides?: {
  persisted?: BClassPersistedNodeConfig;
  peers?: Array<{ ownerId?: string; peerId?: string }>;
  searchPeersFails?: boolean;
  sendHelloFails?: boolean;
  waitForBond?: { peerOwnerId: string; displayName?: string } | undefined;
  probeMeshReady?: boolean;
  probeProfileReady?: boolean;
  alreadyBonded?: boolean;
  maxAttempts?: number;
  forceResolveConfig?: boolean;
}): {
  deps: BClassSponsorFriendDeps;
  saveLog: BClassPersistedNodeConfig[];
  traceLog: Array<{ step: number; status: string; message: string; fields?: Record<string, unknown> }>;
} {
  const saved: BClassPersistedNodeConfig[] = [];
  const traceLog: { step: number; status: string; message: string; fields?: Record<string, unknown> }[] = [];
  const persisted = overrides?.persisted;
  const peers = overrides?.peers ?? [{ ownerId: "sponsor-owner", peerId: "12D3KooWSponsor" }];

  const mesh: BClassSponsorFriendDeps["mesh"] = {
    searchPeers: async () => {
      if (overrides?.searchPeersFails) throw new Error("sponsor peer not found in mesh");
      return peers;
    },
    sendHello: async () => {
      if (overrides?.sendHelloFails) throw new Error("network unreachable: dial timeout");
      return { messageId: "msg-1" };
    },
    applyWanJoinInvite: async () => ({}),
    assertOnline: () => {},
    peerMultiaddrs: ["/ip4/1.2.3.4/tcp/4001"],
    localDiscoveryProfile: "wan-default",
  };
  if (overrides?.waitForBond !== undefined) {
    mesh.waitForBondEstablished = async () => overrides.waitForBond as { peerOwnerId: string; displayName?: string };
  }
  if (overrides?.probeMeshReady !== undefined) {
    mesh.probeMeshReady = async () => overrides.probeMeshReady as boolean;
  }

  const profile: BClassSponsorFriendDeps["profile"] = {
    loadNodeProfile: async () => ({ owner: { ownerId: "self" }, peerId: "12D3KooWSelf" }),
    loadHelloProfile: async () => ({ displayName: "Test User" }),
  };
  if (overrides?.probeProfileReady !== undefined) {
    profile.probeHumanProfileReady = async () => overrides.probeProfileReady as boolean;
  }
  if (overrides?.alreadyBonded !== undefined) {
    profile.isAlreadyBondedWith = async () => overrides.alreadyBonded as boolean;
  }

  const deps: BClassSponsorFriendDeps = {
    mesh,
    profile,
    config: {
      loadNodeConfig: async () => persisted,
      saveNodeConfig: async (cfg) => {
        saved.push(cfg);
      },
      getProfileDir: () => "/tmp/test",
      resolveEffectiveConfig: () => ({
        enabled: true,
        ownerId: "sponsor-owner",
        peerId: "12D3KooWSponsor",
        joinToken: "join-token-abc",
        displayName: "Sponsor",
        helloMessage: "Hello, friend!",
        maxAttempts: overrides?.maxAttempts ?? 3,
        retryDelayMs: 10,
        cooldownMs: 60_000,
      }),
    },
    audit: {
      appendAudit: async () => {},
      now: () => 1_700_000_000_000,
      sleep: async () => {}, // no-op to keep tests fast
      trace: (step, status, message, fields) => {
        if (fields !== undefined) {
          traceLog.push({ step, status, message, fields });
        } else {
          traceLog.push({ step, status, message });
        }
      },
    },
  };
  return { deps, saveLog: saved, traceLog };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetActiveSponsorLoopsForTests();
});

describe("runSponsorFriendBridge (Phase 8 / Step 3 — sponsor-friend B-class skill)", () => {
  describe("early-exit paths", () => {
    it("returns skipped with 'already-completed' when setupSponsorFriendCompletedAt is set and not forced", async () => {
      const { deps } = makeMockDeps({
        persisted: {
          setupSponsorFriendEnabled: true,
          setupSponsorFriendOwnerId: "sponsor-owner",
          setupSponsorFriendCompletedAt: "2026-08-20T10:00:00Z",
        },
      });
      const result = await runSponsorFriendBridge(deps);
      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("already-completed");
    });

    it("returns skipped with 'already-bonded' when trust store says so", async () => {
      const { deps } = makeMockDeps({ alreadyBonded: true });
      const result = await runSponsorFriendBridge(deps);
      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("already-bonded");
    });

    it("returns skipped with 'cooldown' when cooldown is active", async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const { deps } = makeMockDeps({
        persisted: {
          setupSponsorFriendEnabled: true,
          setupSponsorFriendOwnerId: "sponsor-owner",
          setupSponsorFriendCooldownUntil: future,
        },
      });
      const result = await runSponsorFriendBridge(deps);
      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("cooldown");
      expect(result.cooldownUntil).toBe(future);
    });

    it("returns skipped with 'profile-not-ready' when probe says so", async () => {
      const { deps } = makeMockDeps({ probeProfileReady: false });
      const result = await runSponsorFriendBridge(deps);
      expect(result.reason).toBe("profile-not-ready");
    });

    it("returns skipped with 'mesh-not-ready' when probe says so", async () => {
      const { deps } = makeMockDeps({ probeMeshReady: false });
      const result = await runSponsorFriendBridge(deps);
      expect(result.reason).toBe("mesh-not-ready");
    });
  });

  describe("success path", () => {
    it("completes the bond flow and persists setupSponsorFriendCompletedAt", async () => {
      const { deps, saveLog } = makeMockDeps({
        waitForBond: { peerOwnerId: "sponsor-owner", displayName: "Sponsor" },
      });
      const result = await runSponsorFriendBridge(deps);
      expect(result.ok).toBe(true);
      expect(result.ownerId).toBe("sponsor-owner");
      expect(result.attempts).toBe(1);
      // The last save should have setupSponsorFriendCompletedAt.
      const lastSave = saveLog[saveLog.length - 1]!;
      expect(lastSave.setupSponsorFriendCompletedAt).toBeDefined();
    });
  });

  describe("failure path", () => {
    it("returns auto-exhausted after maxAttempts failures", async () => {
      const { deps } = makeMockDeps({
        maxAttempts: 2,
        searchPeersFails: true,
      });
      const result = await runSponsorFriendBridge(deps);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("auto-exhausted");
      expect(result.attempts).toBe(2);
    });
  });
});

describe("sponsorFriendTool (the BUILTIN tool shape)", () => {
  it("returns the runSponsorFriendBridge result as JSON", async () => {
    const { deps } = makeMockDeps({
      alreadyBonded: true,
    });
    const tool = sponsorFriendTool(deps);
    const result = await tool.execute(
      { force: undefined },
      {
        cwd: "/tmp",
        session: {} as never,
        abortSignal: new AbortController().signal,
      },
    );
    const parsed = JSON.parse(result.content as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.skipped).toBe(true);
    expect(parsed.reason).toBe("already-bonded");
  });

  it("has a valid parameters schema (force is optional boolean)", () => {
    const tool = sponsorFriendTool(makeMockDeps().deps);
    expect(tool.parameters.safeParse({}).success).toBe(true);
    expect(tool.parameters.safeParse({ force: true }).success).toBe(true);
    expect(tool.parameters.safeParse({ force: false }).success).toBe(true);
    expect(tool.parameters.safeParse({ force: "yes" }).success).toBe(false);
  });

  it("exposes the right name + description", () => {
    const tool = sponsorFriendTool(makeMockDeps().deps);
    expect(tool.name).toBe("sponsor_friend");
    expect(tool.description).toMatch(/canonical sponsor/i);
  });
});
