/**
 * F9.3.2 tests — `Team.runOnce()` with topological
 * order on `dependsOn`.
 *
 * Covers:
 * 1. Single agent runs.
 * 2. Two agents in a chain (B depends on A).
 * 3. Three agents in a fan-out (B and C depend on A).
 * 4. The topological order preserves the input
 *    order for ties.
 * 5. Upstream agents' final text is included in
 *    the downstream agent's prompt.
 * 6. `${input}` is substituted in each agent's
 *    objective.
 * 7. `TeamResult` carries per-agent results in
 *    execution order.
 * 8. Missing dependency throws.
 * 9. Cycle throws.
 * 10. Per-agent failure → `status: "failed"`,
 *     error message included.
 */

import { describe, expect, it } from "vitest";

import {
  Team,
  type AgentSpec,
  type ModelAdapter,
  type ModelResponse,
  type TeamConfig,
} from "@envoymesh/envoy-harness";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A scripted model that returns one response per
 *  call (in order). Each call's `input` is captured
 *  for inspection. */
function scriptedModel(responses: ReadonlyArray<string>): {
  model: ModelAdapter;
  captured: Array<{ systemPrompt: string; userText: string }>;
} {
  const captured: Array<{ systemPrompt: string; userText: string }> = [];
  let i = 0;
  return {
    captured,
    model: {
      async complete(input): Promise<ModelResponse> {
        // Capture the system prompt (first message)
        // and the user text (last message).
        const systemMsg = input.messages.find((m) => m.role === "system");
        const sysText = systemMsg?.content[0];
        const systemPrompt =
          sysText && sysText.type === "text" ? sysText.text : "";
        const lastUser = [...input.messages].reverse().find((m) => m.role === "user");
        const userBlock = lastUser?.content[0];
        const userText =
          userBlock && userBlock.type === "text" ? userBlock.text : "";
        captured.push({ systemPrompt, userText });
        const r = responses[i++];
        if (r === undefined) {
          throw new Error(`scriptedModel: exhausted (call #${i})`);
        }
        return {
          content: [{ type: "text", text: r }],
          stopReason: "end_turn",
        };
      },
    },
  };
}

function teamConfig(agents: ReadonlyArray<AgentSpec>, name = "t"): TeamConfig {
  return { name, agents };
}

// ---------------------------------------------------------------------------
// 1. Single agent
// ---------------------------------------------------------------------------

describe("Team.runOnce — single agent", () => {
  it("runs the agent and returns its final text", async () => {
    const { model, captured } = scriptedModel(["hello world"]);
    const team = new Team({
      config: teamConfig([
        {
          id: "a",
          role: "explore",
          systemPrompt: "sp",
          objective: "say hi",
          dependsOn: [],
        },
      ]),
      model,
    });
    const result = await team.runOnce();
    expect(result.status).toBe("completed");
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.id).toBe("a");
    expect(result.agents[0]?.finalText).toBe("hello world");
    // The agent's system prompt was used.
    expect(captured[0]?.systemPrompt).toBe("sp");
    // The agent's objective was used as the user prompt.
    expect(captured[0]?.userText).toBe("say hi");
  });
});

// ---------------------------------------------------------------------------
// 2. Two agents in a chain
// ---------------------------------------------------------------------------

describe("Team.runOnce — chain", () => {
  it("runs A first, then B with A's text in context", async () => {
    const { model, captured } = scriptedModel(["A result", "B result"]);
    const team = new Team({
      config: teamConfig([
        {
          id: "a",
          role: "explore",
          systemPrompt: "sp-a",
          objective: "do A",
          dependsOn: [],
        },
        {
          id: "b",
          role: "review",
          systemPrompt: "sp-b",
          objective: "do B",
          dependsOn: ["a"],
        },
      ]),
      model,
    });
    const result = await team.runOnce();
    expect(result.status).toBe("completed");
    expect(result.agents.map((a) => a.id)).toEqual(["a", "b"]);
    expect(result.agents[0]?.finalText).toBe("A result");
    expect(result.agents[1]?.finalText).toBe("B result");
    // B's user prompt includes A's final text.
    expect(captured[1]?.userText).toContain("do B");
    expect(captured[1]?.userText).toContain("[a]: A result");
  });
});

// ---------------------------------------------------------------------------
// 3. Three agents in a fan-out
// ---------------------------------------------------------------------------

describe("Team.runOnce — fan-out", () => {
  it("A runs first; B and C run after, in input order", async () => {
    const { model } = scriptedModel(["A", "B", "C"]);
    const team = new Team({
      config: teamConfig([
        { id: "a", role: "r", systemPrompt: "sp", objective: "o", dependsOn: [] },
        { id: "b", role: "r", systemPrompt: "sp", objective: "o", dependsOn: ["a"] },
        { id: "c", role: "r", systemPrompt: "sp", objective: "o", dependsOn: ["a"] },
      ]),
      model,
    });
    const result = await team.runOnce();
    expect(result.agents.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// 6. ${input} substitution
// ---------------------------------------------------------------------------

describe("Team.runOnce — ${input} substitution", () => {
  it("substitutes the team-level input in each agent's objective", async () => {
    const { model, captured } = scriptedModel(["done"]);
    const team = new Team({
      config: teamConfig([
        {
          id: "a",
          role: "r",
          systemPrompt: "sp",
          objective: "process ${input}",
          dependsOn: [],
        },
      ]),
      model,
      input: "FILE.txt",
    });
    await team.runOnce();
    expect(captured[0]?.userText).toBe("process FILE.txt");
  });
});

// ---------------------------------------------------------------------------
// 7. TeamResult shape
// ---------------------------------------------------------------------------

describe("TeamResult", () => {
  it("carries per-agent results in execution order with durationMs", async () => {
    const { model } = scriptedModel(["x", "y"]);
    const team = new Team({
      config: teamConfig([
        { id: "a", role: "r", systemPrompt: "sp", objective: "o", dependsOn: [] },
        { id: "b", role: "r", systemPrompt: "sp", objective: "o", dependsOn: ["a"] },
      ]),
      model,
    });
    const result = await team.runOnce();
    expect(result.teamName).toBe("t");
    expect(result.status).toBe("completed");
    expect(result.agents).toHaveLength(2);
    expect(result.agents[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.agents[1]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Missing dependency
// ---------------------------------------------------------------------------

describe("Team.runOnce — missing dependency", () => {
  it("throws when an agent references a non-existent ID", async () => {
    const { model } = scriptedModel(["x"]);
    const team = new Team({
      config: teamConfig([
        {
          id: "a",
          role: "r",
          systemPrompt: "sp",
          objective: "o",
          dependsOn: ["nonexistent"],
        },
      ]),
      model,
    });
    await expect(team.runOnce()).rejects.toThrow(
      /depends on nonexistent, but nonexistent is not in the team/,
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Cycle
// ---------------------------------------------------------------------------

describe("Team.runOnce — cycle", () => {
  it("throws on a cycle (A → B → A)", async () => {
    const { model } = scriptedModel(["x", "y"]);
    const team = new Team({
      config: teamConfig([
        { id: "a", role: "r", systemPrompt: "sp", objective: "o", dependsOn: ["b"] },
        { id: "b", role: "r", systemPrompt: "sp", objective: "o", dependsOn: ["a"] },
      ]),
      model,
    });
    await expect(team.runOnce()).rejects.toThrow(/cycle/);
  });
});

// ---------------------------------------------------------------------------
// 10. Per-agent failure
// ---------------------------------------------------------------------------

describe("Team.runOnce — per-agent failure", () => {
  it("returns status='failed' when an agent's run aborts", async () => {
    let i = 0;
    const failingModel: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        i++;
        if (i === 2) throw new Error("model broke");
        return {
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
        };
      },
    };
    const team = new Team({
      config: teamConfig([
        { id: "a", role: "r", systemPrompt: "sp", objective: "o", dependsOn: [] },
        { id: "b", role: "r", systemPrompt: "sp", objective: "o", dependsOn: ["a"] },
      ]),
      model: failingModel,
    });
    const result = await team.runOnce();
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/agent b aborted/);
    // A's result is present, and B's (failed) output is now
    // recorded too — the error text is useful context.
    expect(result.agents.map((a) => a.id)).toEqual(["a", "b"]);
    expect(result.agents[0]?.finalText).toBe("ok");
    expect(result.agents[1]?.stopReason).toBe("aborted");
  });
});
