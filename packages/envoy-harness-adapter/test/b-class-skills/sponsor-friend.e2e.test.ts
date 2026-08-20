/**
 * Phase 8 / Step 3 — `setup-sponsor-friend` B-class skill
 * **end-to-end** test.
 *
 * **What this is:** the e2e test that proves the bridge
 * can run the full `setup-sponsor-friend` flow
 * (search → applyWanJoinInvite → sendHello →
 * waitForBondEstablished → persist success) without
 * OpenClaw, without real network, without a real
 * sponsor. The 10 unit tests in
 * `sponsor-friend.test.ts` cover the algorithm's
 * branches in isolation; this test exercises them
 * together.
 *
 * **Why an e2e test exists even though the unit tests
 * already cover the success path:** the unit tests
 * use `it.skipIf`-friendly mocks for the LLM (none —
 * the algorithm doesn't call one) and a synthetic
 * `BClassSponsorFriendDeps`. The e2e test composes
 * the FULL deps shape with realistic timing + trace
 * assertions, so any future refactor that breaks the
 * algorithm's flow (e.g. reorders the steps, drops a
 * `trace` call, or changes the persisted state's
 * shape) gets caught here.
 *
 * **Opt-in (per the Step 3 plan §4.3):** runs only
 * when `RUN_B_CLASS_E2E=1`. CI does not set this;
 * developers run via `RUN_B_CLASS_E2E=1 pnpm test`.
 * The test is hermetic (no real network, no real LLM)
 * so the opt-in is purely a "skip in CI" gate, not a
 * "needs API key" gate.
 *
 * **Why we use `makeMockDeps` again (instead of
 * importing the one from `sponsor-friend.test.ts`):**
 * `*.test.ts` files don't import from each other
 * (vitest convention; prevents accidental
 * cross-test state leaks). The helper is small
 * enough to duplicate.
 *
 * **Stability:** the public surface is `it.skipIf` +
 * the describe block. New assertions are additive.
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
// Self-skip gate
// ---------------------------------------------------------------------------

/**
 * The e2e test runs only when `RUN_B_CLASS_E2E=1`.
 *
 * **Why an opt-in:** the test is hermetic (no real
 * network, no real LLM) so the opt-in is purely a
 * "skip in CI" gate. CI doesn't set `RUN_B_CLASS_E2E`,
 * so the test is skipped there; developers run
 * `RUN_B_CLASS_E2E=1 pnpm test` to exercise the full
 * flow locally.
 *
 * **Why not `liveDescribe` from `test/live/helpers.ts`:**
 * the live-test lane is for real network calls (LLM
 * providers). This e2e is hermetic; using
 * `liveDescribe` would couple the test to the live-
 * test convention (which requires an env var +
 * API key check). The `it.skipIf` here is the
 * simpler opt-in.
 */
const E2E_OPT_IN = process.env["RUN_B_CLASS_E2E"] === "1";

// ---------------------------------------------------------------------------
// Fixtures (duplicated from sponsor-friend.test.ts — see header note)
// ---------------------------------------------------------------------------

function makeE2EDeps(input?: {
  persisted?: BClassPersistedNodeConfig;
  maxAttempts?: number;
}): {
  deps: BClassSponsorFriendDeps;
  saveLog: BClassPersistedNodeConfig[];
  traceLog: Array<{ step: number; status: string; message: string; fields?: Record<string, unknown> }>;
  sendHelloCalls: Array<{
    targetOwnerId: string;
    profile: unknown;
    message: string;
    options: unknown;
  }>;
} {
  const saved: BClassPersistedNodeConfig[] = [];
  const traceLog: { step: number; status: string; message: string; fields?: Record<string, unknown> }[] = [];
  const sendHelloCalls: { targetOwnerId: string; profile: unknown; message: string; options: unknown }[] = [];
  const persisted = input?.persisted;

  const deps: BClassSponsorFriendDeps = {
    mesh: {
      searchPeers: async () => [
        { ownerId: "sponsor-owner", peerId: "12D3KooWSponsor" },
      ],
      sendHello: async (targetOwnerId, profile, message, options) => {
        sendHelloCalls.push({ targetOwnerId, profile, message, options });
        return { messageId: "msg-e2e-1" };
      },
      applyWanJoinInvite: async () => ({}),
      assertOnline: () => {},
      // `waitForBondEstablished` resolves immediately
      // with the sponsor's ownerId. The bridge's
      // algorithm then persists `setupSponsorFriendCompletedAt`.
      waitForBondEstablished: async (targetOwnerId) => ({
        peerOwnerId: targetOwnerId,
        displayName: "Sponsor Display Name",
      }),
      peerMultiaddrs: ["/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWSponsor"],
      localDiscoveryProfile: "wan-default",
    },
    profile: {
      loadNodeProfile: async () => ({
        owner: { ownerId: "self-owner" },
        peerId: "12D3KooWSelf",
      }),
      loadHelloProfile: async () => ({ displayName: "Installer" }),
    },
    config: {
      loadNodeConfig: async () => persisted,
      saveNodeConfig: async (cfg) => {
        saved.push(cfg);
      },
      getProfileDir: () => "/tmp/e2e",
      resolveEffectiveConfig: () => ({
        enabled: true,
        ownerId: "sponsor-owner",
        peerId: "12D3KooWSponsor",
        joinToken: "join-token-e2e",
        displayName: "Sponsor Display Name",
        helloMessage: "Hello, sponsor!",
        proofOfContext: "proof-e2e",
        maxAttempts: input?.maxAttempts ?? 1,
        retryDelayMs: 10,
        cooldownMs: 60_000,
      }),
    },
    audit: {
      appendAudit: async () => {},
      now: () => 1_700_000_000_000,
      sleep: async () => {}, // no-op to keep the e2e fast
      trace: (step, status, message, fields) => {
        if (fields !== undefined) {
          traceLog.push({ step, status, message, fields });
        } else {
          traceLog.push({ step, status, message });
        }
      },
    },
  };
  return { deps, saveLog: saved, traceLog, sendHelloCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetActiveSponsorLoopsForTests();
});

describe("runSponsorFriendBridge (Phase 8 / Step 3 — e2e: full sponsor-friend flow without OpenClaw)", () => {
  it.skipIf(!E2E_OPT_IN)(
    "drives the full search → applyWanJoinInvite → sendHello → waitForBondEstablished → persist flow",
    async () => {
      // The operator enables the sponsor-friend flow
      // before the bond attempt (the bundle's
      // `setupSponsorFriendEnabled: true` is the
      // signal). The persisted state mirrors that
      // pre-condition. The bridge's job is to stamp
      // `setupSponsorFriendCompletedAt` on success;
      // it does NOT toggle `setupSponsorFriendEnabled`
      // (that's an operator decision, not a runtime
      // decision).
      const { deps, saveLog, traceLog, sendHelloCalls } = makeE2EDeps({
        persisted: {
          setupSponsorFriendEnabled: true,
          setupSponsorFriendOwnerId: "sponsor-owner",
          setupSponsorFriendPeerId: "12D3KooWSponsor",
          setupSponsorFriendMaxAttempts: 1,
          setupSponsorFriendRetryDelayMs: 0,
        },
      });

      const result = await runSponsorFriendBridge(deps);

      // 1. The result is a clean success.
      expect(result.ok).toBe(true);
      expect(result.ownerId).toBe("sponsor-owner");
      expect(result.attempts).toBe(1);
      // No skip / reason fields on a clean success.
      expect(result.skipped).toBeUndefined();
      expect(result.reason).toBeUndefined();
      expect(result.finalNote).toBeUndefined();

      // 2. The full algorithm ran (one sendHello call,
      // one applyWanJoinInvite, one waitForBondEstablished,
      // one persist-success). We assert via the trace
      // log: the bridge emits 5 trace steps (1=search,
      // 2=apply, 3=sendHello, 4=waitForBond, 5=complete).
      // The exact step numbers are part of the public
      // contract (Step 3 plan §3.5: "Each emits a
      // bond-trace log line for observability").
      const stepNumbers = traceLog.map((t) => t.step);
      expect(stepNumbers).toContain(1);
      expect(stepNumbers).toContain(2);
      expect(stepNumbers).toContain(3);
      expect(stepNumbers).toContain(4);
      expect(stepNumbers).toContain(5);

      // 3. The final step is the success marker
      // ("auto-bond COMPLETE"). The message is part
      // of the public contract — Step 3 plan §3.5
      // ("auto-bond COMPLETE — all 4 steps succeeded").
      const finalTrace = traceLog.find((t) => t.step === 5);
      expect(finalTrace).toBeDefined();
      expect(finalTrace?.status).toBe("PASS");
      expect(finalTrace?.message).toMatch(/auto-bond COMPLETE/i);

      // 4. sendHello was called exactly once with the
      // expected target + message + proof context.
      expect(sendHelloCalls).toHaveLength(1);
      expect(sendHelloCalls[0]?.targetOwnerId).toBe("sponsor-owner");
      expect(sendHelloCalls[0]?.message).toBe("Hello, sponsor!");
      // The bridge passes the `proofOfContext` from
      // the resolved config. v0's bridge interface
      // uses `proofOfContext` (the bridge maps it to
      // the host's `SendHelloOptions.proofOfContext`
      // — see the host-side `buildBridgeDeps`).
      const sendOpts = sendHelloCalls[0]?.options as
        | { proofOfContext?: string; preferredOwnerId?: string }
        | undefined;
      expect(sendOpts?.proofOfContext).toBe("proof-e2e");
      expect(sendOpts?.preferredOwnerId).toBe("12D3KooWSponsor");

      // 5. The persisted state has
      // `setupSponsorFriendCompletedAt` stamped.
      // The saveLog has 1 entry (the success path
      // doesn't persist per-attempt failures; only
      // the final success).
      expect(saveLog).toHaveLength(1);
      const persisted = saveLog[0];
      expect(persisted).toBeDefined();
      expect(persisted?.setupSponsorFriendEnabled).toBe(true);
      expect(persisted?.setupSponsorFriendOwnerId).toBe("sponsor-owner");
      expect(persisted?.setupSponsorFriendPeerId).toBe("12D3KooWSponsor");
      // ISO timestamp: parse + verify it's the
      // injected `now()` (1_700_000_000_000).
      const completedAt = persisted?.setupSponsorFriendCompletedAt;
      expect(typeof completedAt).toBe("string");
      expect(Date.parse(completedAt as string)).toBe(1_700_000_000_000);
      // Cooldown + last error are cleared on success.
      expect(persisted?.setupSponsorFriendCooldownUntil).toBeUndefined();
      expect(persisted?.setupSponsorFriendLastError).toBeUndefined();
      expect(persisted?.setupSponsorFriendLastErrorKind).toBeUndefined();
    },
    // Generous timeout: the test is fast (no
    // real I/O, no-op sleep) but CI runners can be
    // slow. 10s is plenty.
    10_000,
  );

  it.skipIf(!E2E_OPT_IN)(
    "the sponsor_friend BUILTIN tool wraps the bridge and returns a JSON result",
    async () => {
      // The bridge's BUILTIN tool (`sponsor_friend`)
      // is the surface envoy-harness's model invokes
      // when the orchestrator picks the
      // `setup-sponsor-friend` skill. The e2e proves
      // the tool wraps the bridge correctly: a
      // `force: false` (default) call returns the
      // bridge's `BClassSponsorFriendResult` as JSON.
      const { deps } = makeE2EDeps();
      const tool = sponsorFriendTool(deps);

      // The tool's zod schema accepts `{ force?: boolean }`.
      // We pass `{}` (the model would call without args).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx: any = { cwd: "/tmp/e2e", sessionId: "sess-e2e" };
      const result = await tool.execute(
        { force: false },
        ctx,
      );

      // The tool's return shape is `{ content: string }`
      // (text-in/text-out for the agent). The `content`
      // is `JSON.stringify(bridgeResult)`.
      expect(result.content).toContain("\"ok\":true");
      expect(result.content).toContain("\"ownerId\":\"sponsor-owner\"");
      expect(result.content).toContain("\"attempts\":1");
    },
    10_000,
  );
});
