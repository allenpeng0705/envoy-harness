import { describe, expect, it } from "vitest";
import {
  parseSessionGoalsParams,
  parseSessionScheduleParams,
} from "../src/protocol/acp-params.js";
import { JsonRpcError } from "../src/protocol/types.js";

describe("session schedule/goals params", () => {
  it("parses schedule list/create/tick", () => {
    expect(
      parseSessionScheduleParams({ sessionId: "s1", action: "list" }),
    ).toEqual({ sessionId: "s1", action: "list" });
    expect(
      parseSessionScheduleParams({
        sessionId: "s1",
        action: "create",
        prompt: " ping ",
        everyMs: 1000,
      }),
    ).toEqual({
      sessionId: "s1",
      action: "create",
      prompt: "ping",
      everyMs: 1000,
    });
    expect(
      parseSessionScheduleParams({ sessionId: "s1", action: "tick" }).action,
    ).toBe("tick");
  });

  it("rejects create without prompt", () => {
    expect(() =>
      parseSessionScheduleParams({ sessionId: "s1", action: "create" }),
    ).toThrow(JsonRpcError);
  });

  it("parses goals list/create", () => {
    expect(parseSessionGoalsParams({ sessionId: "s1" })).toEqual({
      sessionId: "s1",
      action: "list",
    });
    expect(
      parseSessionGoalsParams({
        sessionId: "s1",
        action: "create",
        title: " Ship ",
        detail: " notes ",
      }),
    ).toEqual({
      sessionId: "s1",
      action: "create",
      title: "Ship",
      detail: "notes",
    });
  });
});
