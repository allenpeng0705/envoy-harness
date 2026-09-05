/**
 * R4.5a — deny > ask > allow merge + refresh mid-fire.
 */

import { describe, expect, it } from "vitest";

import {
  HookRegistry,
  mergeHookDecisions,
  type HookDecision,
} from "../../src/index.js";

describe("mergeHookDecisions (deny > ask > allow)", () => {
  const cases: Array<{
    name: string;
    decisions: HookDecision[];
    expect: HookDecision;
  }> = [
    {
      name: "deny then ask → deny",
      decisions: [
        { kind: "block", reason: "denied" },
        { kind: "ask", question: "ok?" },
      ],
      expect: { kind: "block", reason: "denied" },
    },
    {
      name: "ask then deny → deny",
      decisions: [
        { kind: "ask", question: "ok?" },
        { kind: "block", reason: "denied" },
      ],
      expect: { kind: "block", reason: "denied" },
    },
    {
      name: "allow then ask → ask",
      decisions: [
        { kind: "continue" },
        { kind: "ask", question: "ok?" },
      ],
      expect: { kind: "ask", question: "ok?" },
    },
    {
      name: "ask then allow → ask",
      decisions: [
        { kind: "ask", question: "ok?" },
        { kind: "continue" },
      ],
      expect: { kind: "ask", question: "ok?" },
    },
    {
      name: "only allows → continue",
      decisions: [{ kind: "continue" }, { kind: "continue" }],
      expect: { kind: "continue" },
    },
    {
      name: "deny beats add-context",
      decisions: [
        { kind: "add-context", content: "note" },
        { kind: "block", reason: "no" },
      ],
      expect: { kind: "block", reason: "no" },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(mergeHookDecisions("PreToolUse", c.decisions)).toEqual(c.expect);
    });
  }
});

describe("HookRegistry.refresh mid-fire", () => {
  it("in-flight fire keeps snapshotted handlers after refresh", async () => {
    const r = new HookRegistry();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    r.on("PreToolUse", async () => {
      await gate;
      return { kind: "add-context", content: "original" };
    });

    const pending = r.fire("PreToolUse", { tool: "bash" });

    r.refresh((reg) => {
      reg.on("PreToolUse", async () => ({
        kind: "block",
        reason: "refreshed-deny",
      }));
    });

    // New fires see refreshed handlers.
    const after = await r.fire("PreToolUse", { tool: "bash" });
    expect(after).toEqual({ kind: "block", reason: "refreshed-deny" });

    release?.();
    const inFlight = await pending;
    expect(inFlight).toEqual({
      kind: "add-context",
      content: "original",
    });
  });
});
