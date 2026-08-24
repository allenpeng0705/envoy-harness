import { describe, expect, it } from "vitest";

import { makeSuggestFollowUpsTool } from "../../src/interaction/suggest-follow-ups-tool.js";
import {
  emptyTurnHints,
  hasTurnHints,
  mergeTurnHints,
} from "../../src/interaction/turn-hints.js";

describe("turn hints", () => {
  it("merges follow-ups and deferred entries", () => {
    const merged = mergeTurnHints(emptyTurnHints(), {
      followUps: ["Run tests", "Run tests"],
      deferred: [{ task: "Migrate DB", reason: "Needs credentials" }],
    });
    expect(merged.followUps).toEqual(["Run tests"]);
    expect(merged.deferred).toHaveLength(1);
    expect(hasTurnHints(merged)).toBe(true);
  });

  it("records hints via suggest_follow_ups tool", async () => {
    let recorded = emptyTurnHints();
    const tool = makeSuggestFollowUpsTool({
      record: (hints) => {
        recorded = mergeTurnHints(recorded, hints);
      },
    });
    const result = await tool.execute(
      {
        followUps: ["Add docs"],
        deferred: [{ task: "Deploy", reason: "Needs approval" }],
      },
      {
        cwd: "/tmp",
        session: { id: "s1" } as never,
        abortSignal: new AbortController().signal,
      },
    );
    expect(result.content).toMatch(/follow-up/);
    expect(recorded.followUps).toEqual(["Add docs"]);
    expect(recorded.deferred?.[0]?.task).toBe("Deploy");
  });
});
