/**
 * Compaction durability at the CALL SITES.
 *
 * **The contract under test.** `replaceMessages` publishes atomically,
 * which guarantees a crash keeps the *old* transcript — not that the
 * compaction itself survives. So a caller that reports "compacted" without
 * a durability barrier is telling the user something that a crash will
 * silently revert. Every caller must therefore `await flushSession()`
 * *before* reporting success.
 *
 * The test does not race a timer. It gates the flush on a promise and
 * asserts that the caller's own promise has not resolved while the flush
 * is still pending — which is exactly what "awaited the barrier" means.
 */

import { describe, expect, it, vi } from "vitest";
import { removeTempDir } from "./support/tmp-dir.js";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Agent, SessionStore, ToolRegistry } from "../src/index.js";
import { createAgentSessionBackend } from "../src/protocol/index.js";
import { HookRegistry } from "../src/hooks/index.js";
import { FakeModel, textResponse } from "./fixtures/fake-model.js";

/**
 * Poll `check` until it is true or the deadline passes.
 *
 * Used instead of a fixed sleep so the test cannot flake when the suite
 * runs under load: the assertion is about ORDER (did the flush happen
 * before the caller resolved?), not about how long anything takes.
 */
async function waitUntil(
  check: () => boolean,
  deadlineMs = 5_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return check();
}

/** A promise plus its resolver, for gating the flush. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function withStore<T>(
  run: (store: SessionStore) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "envoy-compact-dur-"));
  try {
    return await run(new SessionStore({ dir }));
  } finally {
    await removeTempDir(dir);
  }
}

/**
 * Build an ACP backend whose agent's `flushSession` blocks on a gate, and
 * report whether the backend's call resolved before the gate opened.
 */
async function probeCompaction(
  params: { budget?: number; keep?: number },
): Promise<{ flushed: boolean; resolvedWhilePending: boolean }> {
  return withStore(async (store) => {
    const gate = deferred();
    let flushed = false;
    const backend = createAgentSessionBackend({
      defaultCwd: "/proj",
      sessionStore: store,
      createAgent: ({ sessionId, cwd, session, askHandler }) => {
        const agent = new Agent({
          model: new FakeModel([textResponse("ok")]),
          tools: new ToolRegistry(),
          hooks: new HookRegistry(),
          session: session!,
          cwd: cwd ?? "/proj",
          ...(askHandler !== undefined ? { askHandler } : {}),
        });
        // Seed enough transcript to make a budget compaction drop
        // something, then gate the durability barrier.
        for (let i = 0; i < 40; i += 1) {
          agent.getSession().appendMessage("user", [
            { type: "text", text: `message number ${i} with some words in it` },
          ]);
        }
        const original = agent.flushSession.bind(agent);
        vi.spyOn(agent, "flushSession").mockImplementation(async () => {
          flushed = true;
          await gate.promise;
          await original();
        });
        void sessionId;
        return agent;
      },
    });

    const { sessionId } = await backend.createSession({ cwd: "/proj" });
    const pending = backend.compact!({ sessionId, ...params });
    let resolvedWhilePending = false;
    void pending.then(
      () => {
        resolvedWhilePending = true;
      },
      () => {
        resolvedWhilePending = true;
      },
    );
    // Let the compaction run up to (and into) the barrier. Poll rather
    // than sleep a fixed interval: under parallel load the setup can take
    // longer than any constant we could pick.
    await waitUntil(() => flushed);
    const observed = { flushed, resolvedWhilePending };
    gate.resolve();
    await pending;
    return observed;
  });
}

describe("ACP compact awaits the durability barrier", () => {
  it("budget path: flushes, and does not report success before it lands", async () => {
    const { flushed, resolvedWhilePending } = await probeCompaction({ budget: 20 });
    expect(flushed).toBe(true);
    expect(
      resolvedWhilePending,
      "compact reported success while durability was still pending",
    ).toBe(false);
  });

  it("keep path: flushes, and does not report success before it lands", async () => {
    const { flushed, resolvedWhilePending } = await probeCompaction({ keep: 5 });
    expect(flushed).toBe(true);
    expect(resolvedWhilePending).toBe(false);
  });
});
