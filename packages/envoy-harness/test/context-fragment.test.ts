/**
 * Phase 8 / v2.1 — bounded context fragment tests.
 */

import { describe, expect, it } from "vitest";

import {
  assembleFragments,
  createBoundedFragment,
  DEFAULT_FRAGMENT_TOKEN_CAP,
} from "../src/context/fragment.js";

describe("createBoundedFragment", () => {
  it("constructs a fragment within the cap", () => {
    const f = createBoundedFragment({
      id: "objective",
      owner: "subtask-objective",
      priority: 100,
      estimatedTokens: 500,
      text: "do the thing",
    });
    expect(f.render()).toBe("do the thing");
    expect(f.estimatedTokens).toBe(500);
    expect(f.priority).toBe(100);
  });

  it("rejects an over-cap fragment at construction", () => {
    expect(() =>
      createBoundedFragment({
        id: "huge",
        owner: "worker-response",
        estimatedTokens: DEFAULT_FRAGMENT_TOKEN_CAP + 1,
        text: "x",
      }),
    ).toThrow(/exceeds the token cap/);
  });

  it("honors a custom tokenCap", () => {
    expect(() =>
      createBoundedFragment({
        id: "small-cap",
        owner: "test",
        estimatedTokens: 100,
        tokenCap: 50,
        text: "x",
      }),
    ).toThrow(/exceeds the token cap/);
  });
});

describe("assembleFragments", () => {
  const frag = (id: string, priority: number, tokens: number) =>
    createBoundedFragment({
      id,
      owner: "test",
      priority,
      estimatedTokens: tokens,
      text: `[${id}]`,
    });

  it("renders in priority order (stable for ties)", () => {
    const result = assembleFragments(
      [frag("low", 10, 1), frag("high", 100, 1), frag("mid", 50, 1)],
      100,
    );
    expect(result.included).toEqual(["high", "mid", "low"]);
    expect(result.text).toBe("[high]\n\n[mid]\n\n[low]");
    expect(result.dropped).toEqual([]);
  });

  it("drops the lowest-priority fragments when over budget", () => {
    const result = assembleFragments(
      [frag("objective", 100, 10), frag("verdict", 50, 10), frag("worker", 10, 10)],
      25,
    );
    expect(result.included).toEqual(["objective", "verdict"]);
    expect(result.dropped).toEqual(["worker"]);
    expect(result.totalTokens).toBe(20);
  });

  it("empty input yields empty output", () => {
    const result = assembleFragments([], 100);
    expect(result.text).toBe("");
    expect(result.dropped).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });
});
