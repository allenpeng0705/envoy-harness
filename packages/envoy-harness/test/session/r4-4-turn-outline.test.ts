/**
 * R4.4 — turn outline matches full replay on fixture log.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildTurnOutlineFromMessages,
  loadTurnOutlineFromFile,
  PersistedSession,
  TurnOutlineRegistry,
  type Message,
} from "../../src/index.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/sessions/multi-turn.jsonl",
);

describe("R4.4 turn outline", () => {
  it("incremental registry matches full-replay builder on fixture", async () => {
    const fromFile = await loadTurnOutlineFromFile(FIXTURE);
    expect(fromFile.sessionId).toBe("sess-r4-4-fixture");
    expect(fromFile.turns).toHaveLength(3);

    const session = await PersistedSession.openReadOnly(FIXTURE);
    const reference = buildTurnOutlineFromMessages(
      session.id,
      session.messages,
    );
    expect(fromFile).toEqual(reference);

    const reg = new TurnOutlineRegistry(session.id);
    for (const m of session.messages) {
      reg.appendMessage(m as Message);
    }
    expect(reg.snapshot()).toEqual(reference);

    expect(reference.turns[0]).toMatchObject({
      turnIndex: 0,
      startMessageIndex: 0,
      toolCallCount: 1,
      toolNames: ["bash"],
      userPreview: "list files in src",
    });
    expect(reference.turns[1]).toMatchObject({
      turnIndex: 1,
      toolCallCount: 2,
      toolNames: ["read_file", "bash"],
      userPreview: "read a.ts",
    });
    expect(reference.turns[2]).toMatchObject({
      turnIndex: 2,
      toolCallCount: 0,
      toolNames: [],
      userPreview: "thanks",
    });
    // Turn 0 spans user + assistant + tool + assistant = indices 0..3
    expect(reference.turns[0]!.endMessageIndex).toBe(3);
  });

  it("empty transcript yields empty turns", () => {
    expect(buildTurnOutlineFromMessages("s", []).turns).toEqual([]);
  });
});
