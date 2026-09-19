/**
 * Compare-and-abort — hermetic tests.
 *
 * A deadline, watchdog, hook timeout or extension typically captures a
 * turn reference and fires later. With an unconditional abort, a late
 * abort arriving after the turn finished killed the **next** turn — the
 * symptom is a turn that dies for no visible reason.
 *
 * `abortTurnIfActive(turnId)` aborts only when that turn is still the one
 * running; `activeTurnId` exposes the identity so a host can capture it.
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  InMemorySession,
  ToolRegistry,
  newSessionId,
  type ModelAdapter,
  type ModelResponse,
} from "../src/index.js";

interface StallingModel {
  readonly adapter: ModelAdapter;
  readonly calls: () => number;
  /** Release every stalled call. */
  readonly release: () => void;
}

/**
 * A model that answers immediately, or stalls until `release()` when
 * `stall` is set. Stalling lets a test observe the turn while it runs.
 */
function stallingModel(stall: boolean): StallingModel {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const adapter: ModelAdapter = {
    async complete(): Promise<ModelResponse> {
      calls += 1;
      if (stall) await gate;
      return {
        content: [{ type: "text", text: `reply ${calls}` }],
        stopReason: "end_turn",
      };
    },
  };
  return { adapter, calls: () => calls, release: () => release() };
}

function makeAgent(model: ModelAdapter): Agent {
  return new Agent({
    model,
    tools: new ToolRegistry(),
    session: new InMemorySession(newSessionId(), {
      cwd: process.cwd(),
      permissionMode: "read-only",
      startedAt: new Date().toISOString(),
    }),
    cwd: process.cwd(),
    maxIterations: 4,
  });
}

/** Let the running turn reach its model call. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("turn identity", () => {
  it("is undefined while idle and set while a turn runs", async () => {
    const m = stallingModel(true);
    const agent = makeAgent(m.adapter);
    expect(agent.activeTurnId).toBeUndefined();

    const running = agent.run("hi");
    await settle();
    expect(agent.activeTurnId).toBeDefined();

    m.release();
    await running;
    expect(agent.activeTurnId).toBeUndefined();
  });

  it("gives consecutive turns distinct ids", async () => {
    const m = stallingModel(false);
    const agent = makeAgent(m.adapter);

    const first = agent.run("one");
    const firstId = agent.activeTurnId;
    await first;

    const second = agent.run("two");
    const secondId = agent.activeTurnId;
    await second;

    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    expect(firstId).not.toBe(secondId);
  });

  it("clears the turn id even when the turn aborts", async () => {
    const m = stallingModel(true);
    const agent = makeAgent(m.adapter);
    const running = agent.run("hi");
    await settle();

    agent.abortTurnIfActive(agent.activeTurnId!, "watchdog");
    m.release();
    await running;

    expect(agent.activeTurnId).toBeUndefined();
  });
});

describe("abortTurnIfActive", () => {
  it("aborts the running turn and reports true", async () => {
    const m = stallingModel(true);
    const agent = makeAgent(m.adapter);
    const running = agent.run("hi");
    await settle();

    const applied = agent.abortTurnIfActive(agent.activeTurnId!, "watchdog");
    expect(applied).toBe(true);

    m.release();
    const result = await running;
    expect(result.stopReason).toBe("aborted");
  });

  it("refuses a stale abort, and the NEXT turn survives", async () => {
    // The bug: a watchdog that fired late used to kill turn 2.
    const m = stallingModel(false);
    const agent = makeAgent(m.adapter);

    const turn1 = agent.run("one");
    const turn1Id = agent.activeTurnId!;
    await turn1;

    expect(agent.abortTurnIfActive(turn1Id, "stale watchdog")).toBe(false);

    const result = await agent.run("two");
    expect(result.stopReason).toBe("end_turn");
    expect(agent.abortController.signal.aborted).toBe(false);
    expect(m.calls()).toBe(2);
  });

  it("refuses an unknown turn id without side effects", () => {
    const m = stallingModel(false);
    const agent = makeAgent(m.adapter);
    expect(agent.abortTurnIfActive("turn-does-not-exist")).toBe(false);
    expect(agent.abortController.signal.aborted).toBe(false);
  });

  it("reports false when idle", () => {
    const m = stallingModel(false);
    const agent = makeAgent(m.adapter);
    expect(agent.abortTurnIfActive("turn-1")).toBe(false);
  });
});

describe("the unconditional abort still works (Ctrl-C semantics)", () => {
  it("aborts whatever is running", async () => {
    const m = stallingModel(true);
    const agent = makeAgent(m.adapter);
    const running = agent.run("hi");
    await settle();

    agent.abort("user pressed Ctrl-C");
    m.release();
    const result = await running;
    expect(result.stopReason).toBe("aborted");
  });
});
