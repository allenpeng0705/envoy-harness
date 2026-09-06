/**
 * R4.1 — TuiSession user-question waiter.
 */

import { describe, expect, it } from "vitest";

import { createInProcessTui } from "../src/in-process.js";

describe("TuiSession user questions", () => {
  it("answerUserQuestion resolves the waiter", async () => {
    const { session, close } = createInProcessTui();
    const pending = session.handleUserQuestionRequest({
      sessionId: "s1",
      questionId: "q1",
      prompt: "Continue?",
      options: ["yes", "no"],
      recommendedIndex: 0,
    });
    expect(session.pendingUserQuestion?.prompt).toBe("Continue?");
    expect(session.answerUserQuestion({ value: "yes", optionIndex: 0 })).toBe(
      true,
    );
    await expect(pending).resolves.toEqual({
      value: "yes",
      optionIndex: 0,
    });
    expect(session.pendingUserQuestion).toBeUndefined();
    close();
  });

  it("cancelUserQuestion resolves with cancelled: true", async () => {
    const { session, close } = createInProcessTui();
    const pending = session.handleUserQuestionRequest({
      sessionId: "s1",
      questionId: "q2",
      prompt: "Abort?",
    });
    expect(session.cancelUserQuestion()).toBe(true);
    await expect(pending).resolves.toEqual({
      value: "",
      cancelled: true,
    });
    expect(session.pendingUserQuestion).toBeUndefined();
    close();
  });
});
