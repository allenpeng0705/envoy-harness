/**
 * R4.9a — continuable local sub-agents.
 */
import { describe, expect, it } from "vitest";

import {
  LocalMeshSubmitter,
  defaultBuildSubagentFactory,
  type ModelAdapter,
  type ModelResponse,
  type SubagentResult,
} from "../src/index.js";

function scriptedModel(
  responses: ReadonlyArray<{
    content: ModelResponse["content"];
    stopReason?: ModelResponse["stopReason"];
  }>,
): ModelAdapter {
  let i = 0;
  return {
    async complete() {
      const r = responses[i++];
      if (!r) throw new Error(`scriptedModel exhausted (call #${i})`);
      return {
        content: r.content,
        stopReason:
          r.stopReason ??
          (r.content.some((b) => b.type === "tool_call")
            ? "tool_use"
            : "end_turn"),
      };
    },
  };
}

function text(text: string): ModelResponse["content"][number] {
  return { type: "text", text };
}

const baseInput = {
  objective: "do the first thing",
  capabilityTag: "test",
  costCeilingUsd: 1,
  deadlineMs: 30_000,
};

describe("LocalMeshSubmitter.submitContinuable", () => {
  it("round-trip: send follow-up then close and waitSettle", async () => {
    const settled: SubagentResult[] = [];
    const model = scriptedModel([
      { content: [text("first turn")] },
      { content: [text("second turn")] },
    ]);
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: defaultBuildSubagentFactory({ model }),
      onSubagentSettle: (r) => {
        settled.push(r);
      },
    });

    const handle = submitter.submitContinuable(baseInput, {
      autoSettleAfterIdle: false,
    });
    expect(handle.status().status).toBe("running");

    // Wait until first turn finishes (inbox empty, parked).
    await new Promise((r) => setTimeout(r, 20));
    await handle.send("follow up please");
    handle.close();
    const result = await handle.waitSettle({ timeoutMs: 5_000 });
    expect(result.status).toBe("completed");
    expect(
      result.content.some(
        (b) => b.type === "text" && b.text.includes("second"),
      ),
    ).toBe(true);
    expect(settled).toHaveLength(1);
    expect(submitter.listSubagents()[0]?.status).toBe("completed");
  });

  it("interrupt settles as failed", async () => {
    // Agent.run checks abort between iterations; for a single
    // complete() we abort the agent so stopReason becomes aborted
    // after the hanging complete resolves — use AbortSignal on
    // the model if passed. FakeModel-style: check agent abort via
    // a slow first response, then interrupt.
    const slowModel = scriptedModel([
      {
        content: [text("slow")],
      },
    ]);
    // Wrap to delay first complete so interrupt can land mid-run.
    let first = true;
    const delayed: ModelAdapter = {
      async complete(input) {
        if (first) {
          first = false;
          await new Promise((r) => setTimeout(r, 50));
        }
        return slowModel.complete(input);
      },
    };
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: defaultBuildSubagentFactory({ model: delayed }),
    });
    const handle = submitter.submitContinuable(
      { ...baseInput, deadlineMs: 60_000 },
      { autoSettleAfterIdle: false },
    );
    await new Promise((r) => setTimeout(r, 10));
    handle.interrupt("stop now");
    const result = await handle.waitSettle({ timeoutMs: 5_000 });
    expect(result.status).toBe("failed");
    expect(handle.status().status).toBe("failed");
  });

  it("blocking submit() still works (auto-settle)", async () => {
    const model = scriptedModel([{ content: [text("one-shot ok")] }]);
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: defaultBuildSubagentFactory({ model }),
    });
    const result = await submitter.submit(baseInput, new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(
      result.content.some(
        (b) => b.type === "text" && b.text.includes("one-shot"),
      ),
    ).toBe(true);
  });

  it("idempotent interrupt and double waitSettle", async () => {
    const model = scriptedModel([{ content: [text("ok")] }]);
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: defaultBuildSubagentFactory({ model }),
    });
    const handle = submitter.submitContinuable(baseInput, {
      autoSettleAfterIdle: true,
    });
    const a = await handle.waitSettle({ timeoutMs: 5_000 });
    const b = await handle.waitSettle({ timeoutMs: 1_000 });
    expect(a).toEqual(b);
    handle.interrupt("again");
    handle.interrupt("again");
    expect(handle.status().status).toBe("completed");
  });

  it("releases the live handle on settle but keeps the record", async () => {
    // The handle holds the child's Agent, transcript and output buffer, so
    // keeping every settled child alive for the process lifetime is a leak —
    // and it would make a dead child look steerable. The *record* is what a
    // UI reads for history, and that stays.
    const model = scriptedModel([{ content: [text("finished")] }]);
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: defaultBuildSubagentFactory({ model }),
    });
    const handle = submitter.submitContinuable(baseInput, {
      autoSettleAfterIdle: true,
    });
    expect(submitter.getHandle(handle.id)).toBeDefined();
    await handle.waitSettle({ timeoutMs: 5_000 });

    expect(submitter.getHandle(handle.id)).toBeUndefined();
    expect(submitter.listSubagents().map((r) => r.sessionId)).toContain(
      handle.id,
    );
    // A caller that already holds the handle can still read its output.
    expect(handle.output()).toContain("finished");
  });

  it("ignores a turn that finishes after the child was interrupted", async () => {
    // An interrupt settles the child immediately (even while a model call is
    // still hanging). When that call later resolves, the turn must not touch
    // the record, the output buffer, or `onTurn` — the job has already
    // reported a terminal status, and a late write would contradict it.
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model: ModelAdapter = {
      async complete(params) {
        started();
        await gate;
        params.onTextDelta?.("late text");
        return {
          content: [text("late text")],
          stopReason: "end_turn",
        };
      },
    };
    const turns: string[] = [];
    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: defaultBuildSubagentFactory({ model }),
    });
    const handle = submitter.submitContinuable(baseInput, {
      autoSettleAfterIdle: false,
      onTurn: () => {
        turns.push("turn");
      },
    });
    await startedP;
    handle.interrupt("stop");
    await handle.waitSettle({ timeoutMs: 5_000 });
    // Let the hung model call resolve and the loop observe it.
    release();
    await new Promise((r) => setTimeout(r, 25));

    expect(turns).toHaveLength(0);
    expect(handle.output()).not.toContain("late text");
    // The interrupt message is the child's output instead.
    expect(handle.output()).toContain("interrupted");
  });
});
