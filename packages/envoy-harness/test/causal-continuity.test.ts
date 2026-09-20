/**
 * Causal continuity and consequence — the two experiments from §14 of
 * *Autonomy Is Causality* (Draft 0.3) that map onto envoy today.
 *
 * - **§14.10 asynchronous causality and dormancy.** An intelligence may be
 *   silent while its context changes, then re-enter. On re-entry it must
 *   keep causal accountability to its earlier outputs *and* be free to
 *   abandon a procedure whose purpose was satisfied while it was away
 *   (§9.7: goal-sensitive, not procedure-sensitive — the 18:48 timer that
 *   should be released at 18:43).
 * - **§14.11 "frequency with which intended consequences are incorrectly
 *   promoted into facts."** A tool call whose result was never recorded has
 *   an *unknown* outcome. Presenting that as anything else is a failure that
 *   reports success.
 *
 * Both are invariants about what the model is allowed to read as settled.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  Agent,
  PLAN_CONTINGENCY_CLAUSE,
  PersistedSession,
  ToolRegistry,
  VERDICT_IS_PREDICTION,
} from "../src/index.js";
import { HookRegistry } from "../src/hooks/index.js";
import { UNKNOWN_OUTCOME_NOTICE } from "../src/session/repair.js";
import { FakeModel, textResponse } from "./fixtures/fake-model.js";
import { removeTempDir } from "./support/tmp-dir.js";

function meta(cwd: string) {
  return {
    cwd,
    permissionMode: "read-only" as const,
    startedAt: new Date().toISOString(),
  };
}

/** Every text block the model was given, flattened. */
function promptText(model: FakeModel, callIndex = 0): string {
  const call = model.calls[callIndex];
  if (call === undefined) throw new Error(`no model call #${callIndex}`);
  return call.messages
    .flatMap((m) => m.content)
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

describe("§14.10 re-entry after dormancy", () => {
  it("keeps the plan (continuity) and marks it contingent (not a script)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "envoy-dormancy-"));
    const filePath = path.join(dir, "dormant.jsonl");
    try {
      // 1. A session with an approved plan, closed cleanly.
      const session = await PersistedSession.create({
        id: "dormant",
        metadata: meta(dir),
        filePath,
      });
      session.appendMessage("user", [
        { type: "text", text: "arrange the surprise dinner" },
      ]);
      session.setPlan({
        active: true,
        reviewStatus: "approved",
        planText:
          "1. Hold Nora until 18:48 so she does not meet Maya at the door.",
        updatedAt: "2026-09-19T18:00:00.000Z",
      });
      await session.close();

      // 2. Time passes and the situation moves on without the agent (Maya
      //    entered early). Nothing is written to the file in the meantime —
      //    the point is that the agent is silent, not that it forgot.
      const resumed = await PersistedSession.open(filePath);

      // 3. Cognition resumes. What does the model actually see?
      const model = new FakeModel([textResponse("released Nora")]);
      const agent = new Agent({
        model,
        tools: new ToolRegistry(),
        hooks: new HookRegistry(),
        session: resumed,
        cwd: dir,
      });
      await agent.run("status?");

      const text = promptText(model);
      // Continuity: the prior intention is still present after the gap.
      expect(text).toContain("Hold Nora until 18:48");
      // ...and accountable to changed conditions rather than binding.
      expect(text).toContain(PLAN_CONTINGENCY_CLAUSE);
      expect(text).toMatch(/contingent on the conditions/);
      expect(text).toMatch(/discharged/);

      // Re-entry did not rewrite history or invent an outcome for the
      // silent interval.
      expect(resumed.repairedOnOpen.danglingToolCalls).toBe(0);
      expect(resumed.repairedOnOpen.tornTail).toBe(false);
      expect(resumed.messages.length).toBeGreaterThanOrEqual(1);
      await resumed.close();
    } finally {
      await removeTempDir(dir);
    }
  });

  it("does not inject the plan when it is not approved", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "envoy-dormancy2-"));
    try {
      const session = await PersistedSession.create({
        id: "draft",
        metadata: meta(dir),
        filePath: path.join(dir, "draft.jsonl"),
      });
      session.setPlan({
        active: true,
        reviewStatus: "draft",
        planText: "DRAFT-ONLY-PLAN",
        updatedAt: "2026-09-19T18:00:00.000Z",
      });
      const model = new FakeModel([textResponse("ok")]);
      await new Agent({
        model,
        tools: new ToolRegistry(),
        hooks: new HookRegistry(),
        session,
        cwd: dir,
      }).run("hi");
      expect(promptText(model)).not.toContain("DRAFT-ONLY-PLAN");
      await session.close();
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe("§14.11 an unrecorded outcome is never promoted to a fact", () => {
  it("the notice marks the outcome UNKNOWN and asserts nothing", () => {
    expect(UNKNOWN_OUTCOME_NOTICE).toContain("UNKNOWN");
    expect(UNKNOWN_OUTCOME_NOTICE).toMatch(/may or may not/);
  });

  it("the notice never claims the operation ran or did not run", () => {
    // The drift this guards against: someone "helpfully" rewording the
    // notice into an assertion. Either direction is a lie — we do not know.
    const forbidden = [
      "did not take effect",
      "had no effect",
      "completed successfully",
      "failed to execute",
      "never ran",
      "was not applied",
    ];
    for (const claim of forbidden) {
      expect(UNKNOWN_OUTCOME_NOTICE.toLowerCase()).not.toContain(claim);
    }
  });

  it("a repaired dangling call is surfaced as an ERROR, not as success", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "envoy-promote-"));
    try {
      // A transcript whose tool call was interrupted before its result.
      const raw =
        JSON.stringify({
          _kind: "header",
          id: "torn",
          metadata: meta(dir),
          formatVersion: 2,
          generation: 1,
        }) +
        "\n" +
        JSON.stringify({
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "call-1",
              name: "bash",
              args: { command: "rm -rf /tmp/maybe" },
            },
          ],
        }) +
        "\n";
      const { writeFile } = await import("node:fs/promises");
      const filePath = path.join(dir, "torn.jsonl");
      await writeFile(filePath, raw, "utf8");

      const session = await PersistedSession.open(filePath);
      expect(session.repairedOnOpen.danglingToolCalls).toBe(1);

      const result = session.messages.at(-1)?.content[0];
      expect(result).toMatchObject({ type: "tool_result", isError: true });
      expect(JSON.stringify(result)).toContain("UNKNOWN");
      await session.close();
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe("a verdict is a prediction, not causal return", () => {
  it("says so in the text the model reads on every `task` call", () => {
    expect(VERDICT_IS_PREDICTION).toContain("PREDICTION");
    expect(VERDICT_IS_PREDICTION).toMatch(/not as evidence that the work succeeded/);
  });

  it("points at the causal evidence instead", () => {
    expect(VERDICT_IS_PREDICTION).toMatch(/command output|test results|diffs/);
    expect(VERDICT_IS_PREDICTION).toMatch(/believe the evidence/);
  });

  it("is part of the task tool's description", async () => {
    const { makeTaskTool } = await import("../src/index.js");
    const tool = makeTaskTool({
      submit: async () => {
        throw new Error("not called");
      },
    } as never);
    expect(tool.description).toContain(VERDICT_IS_PREDICTION);
  });
});
