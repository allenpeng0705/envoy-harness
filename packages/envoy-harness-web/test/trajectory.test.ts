import { describe, expect, it } from "vitest";
import {
  applyToolActivity,
  findOpenToolIndex,
  isToolTrajectoryActivity,
} from "../src/client/trajectory.js";
import type { ChatMessage } from "../src/client/acp/host-types.js";

let seq = 0;
function nextId(): string {
  seq += 1;
  return `t${seq}`;
}

describe("trajectory", () => {
  it("detects tool activities", () => {
    expect(isToolTrajectoryActivity({ kind: "tool_call", summary: "x" })).toBe(
      true,
    );
    expect(
      isToolTrajectoryActivity({ kind: "tool_result", summary: "x" }),
    ).toBe(true);
    expect(
      isToolTrajectoryActivity({ kind: "tool_progress", summary: "x" }),
    ).toBe(true);
    expect(isToolTrajectoryActivity({ kind: "agent_end", summary: "x" })).toBe(
      false,
    );
  });

  it("appends tool_call then closes with successful tool_result", () => {
    seq = 0;
    let messages: ChatMessage[] = [];
    messages = applyToolActivity(
      messages,
      {
        kind: "tool_call",
        summary: "bash: echo hi",
        toolName: "bash",
        toolArgs: { command: "echo hi" },
      },
      nextId,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.tool?.phase).toBe("call");

    messages = applyToolActivity(
      messages,
      {
        kind: "tool_result",
        summary: "bash ok",
        toolName: "bash",
        resultPreview: "hi\n",
        isError: false,
        durationMs: 12,
      },
      nextId,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.tool?.phase).toBe("result");
    expect(messages[0]!.tool?.resultPreview).toBe("hi\n");
    expect(messages[0]!.tool?.isError).toBe(false);
    expect(messages[0]!.tool?.durationMs).toBe(12);
  });

  it("appends progress onto the open card", () => {
    seq = 0;
    let messages = applyToolActivity(
      [],
      { kind: "tool_call", summary: "bash", toolName: "bash" },
      nextId,
    );
    messages = applyToolActivity(
      messages,
      { kind: "tool_progress", summary: "line1", toolName: "bash" },
      nextId,
    );
    messages = applyToolActivity(
      messages,
      { kind: "tool_progress", summary: "line2", toolName: "bash" },
      nextId,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.tool?.progress).toEqual(["line1", "line2"]);
  });

  it("findOpenToolIndex skips completed cards", () => {
    const messages: ChatMessage[] = [
      {
        id: "1",
        role: "tool",
        text: "done",
        at: 0,
        tool: { phase: "result", summary: "done", toolName: "bash" },
      },
      {
        id: "2",
        role: "tool",
        text: "run",
        at: 1,
        tool: { phase: "call", summary: "run", toolName: "read" },
      },
    ];
    expect(
      findOpenToolIndex(messages, { kind: "tool_result", summary: "x", toolName: "read" }),
    ).toBe(1);
  });
});
