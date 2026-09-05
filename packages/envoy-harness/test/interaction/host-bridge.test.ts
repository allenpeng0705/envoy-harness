/**
 * R4.1 — host-bridge user-question provider (hermetic).
 */

import { describe, expect, it } from "vitest";

import { createHostBridgeUserQuestionProvider } from "../../src/interaction/providers/host-bridge.js";

describe("createHostBridgeUserQuestionProvider", () => {
  it("returns no-provider when host ask is unset", async () => {
    const p = createHostBridgeUserQuestionProvider({
      getSessionId: () => "s1",
      getHostAsk: () => undefined,
    });
    const answer = await p.ask({
      prompt: "hi?",
      signal: new AbortController().signal,
    });
    expect(answer).toEqual({
      value: "",
      cancelled: true,
      cancelledReason: "no-provider",
    });
  });

  it("forwards to the host and includes questionId", async () => {
    const seen: string[] = [];
    const p = createHostBridgeUserQuestionProvider({
      getSessionId: () => "sess",
      getHostAsk: () => async (req) => {
        seen.push(req.questionId);
        expect(req.sessionId).toBe("sess");
        expect(req.prompt).toBe("pick one");
        expect(req.options).toEqual(["a", "b"]);
        return { value: "b", optionIndex: 1, cancelled: false };
      },
    });
    const answer = await p.ask({
      prompt: "pick one",
      options: ["a", "b"],
      signal: new AbortController().signal,
    });
    expect(answer).toEqual({ value: "b", optionIndex: 1, cancelled: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.length).toBeGreaterThan(0);
  });

  it("cancels when the signal aborts before host answers", async () => {
    const ac = new AbortController();
    const p = createHostBridgeUserQuestionProvider({
      getSessionId: () => "s",
      getHostAsk: () => () =>
        new Promise(() => {
          /* never resolves */
        }),
    });
    const pending = p.ask({ prompt: "?", signal: ac.signal });
    ac.abort();
    await expect(pending).resolves.toEqual({
      value: "",
      cancelled: true,
      cancelledReason: "aborted",
    });
  });
});
