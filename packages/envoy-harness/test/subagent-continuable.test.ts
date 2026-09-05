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
    let resolveHang: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => {
      resolveHang = resolve;
    });
    const model: ModelAdapter = {
      async complete(input) {
        if (input.signal?.aborted) {
          return {
            content: [text("aborted early")],
            stopReason: "end_turn",
          };
        }
        await hang;
        if (input.signal?.aborted) {
          return {
            content: [text("aborted")],
            stopReason: "end_turn",
          };
        }
        return {
          content: [text("done")],
          stopReason: "end_turn",
        };
      },
    };
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
    resolveHang?.();
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
});
