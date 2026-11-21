/**
 * Wave 4 — prompt-cache prefix contract CI.
 *
 * System / skill / catalog injection order must stay stable across
 * turns so provider prefix caches hit.
 */

import { describe, expect, it } from "vitest";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  ToolRegistry,
  newSessionId,
  type ModelAdapter,
} from "../src/index.js";

describe("prompt-cache prefix stability", () => {
  it("keeps leading system message identical across two turns", async () => {
    const prefixes: string[] = [];
    let turn = 0;
    const model: ModelAdapter = {
      async complete(input) {
        const first = input.messages[0];
        const text =
          first?.role === "system"
            ? first.content
                .filter((b): b is { type: "text"; text: string } => b.type === "text")
                .map((b) => b.text)
                .join("\n")
            : "";
        prefixes.push(text);
        turn += 1;
        return {
          content: [{ type: "text", text: `t${turn}` }],
          stopReason: "end_turn",
        };
      },
    };
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: "/tmp",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
      hooks: new HookRegistry(),
      systemPrompt: "PREFIX_CONTRACT_SYSTEM",
    });
    await agent.run("one");
    await agent.run("two");
    expect(prefixes).toHaveLength(2);
    expect(prefixes[0]).toContain("PREFIX_CONTRACT_SYSTEM");
    expect(prefixes[0]).toBe(prefixes[1]);
  });
});
