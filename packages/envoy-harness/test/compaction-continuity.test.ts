/**
 * Compaction summary continuity.
 *
 * **The property under test.** Compaction is the one operation that
 * deliberately discards transcript. What it keeps therefore decides what a
 * resumed session can still know. Keeping *facts* but losing *why* leaves
 * the model unable to distinguish a settled decision from a coincidence, or
 * a superseded approach from a live one — the transcript says what is true
 * and not how it came to be true.
 *
 * Two things are pinned here: the instruction requires causal content, and
 * there is exactly ONE copy of it. It used to be duplicated — one in
 * `protocol/session-ops.ts`, one inline in the REPL's `/compact
 * --summarize` — so the two compaction entry points could silently
 * summarize with different priorities.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  Agent,
  InMemorySession,
  SUMMARIZE_SYSTEM,
  ToolRegistry,
  newSessionId,
} from "../src/index.js";
import { summarizeDroppedMessages } from "../src/protocol/session-ops.js";
import { HookRegistry } from "../src/hooks/index.js";
import { StringWritable, fakeLineReader, makeArgs } from "./helpers.js";
import { FakeModel, textResponse } from "./fixtures/fake-model.js";
import { runRepl } from "../src/index.js";
import { removeTempDir } from "./support/tmp-dir.js";

function makeAgent(model: FakeModel, session?: InMemorySession): Agent {
  return new Agent({
    model,
    tools: new ToolRegistry(),
    hooks: new HookRegistry(),
    session:
      session ??
      new InMemorySession(newSessionId(), {
        cwd: "/proj",
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      }),
    cwd: "/proj",
  });
}

describe("the summarizer instruction demands causal content", () => {
  it("asks for decisions AND their reasons, before facts", () => {
    expect(SUMMARIZE_SYSTEM).toContain("decisions that were made");
    expect(SUMMARIZE_SYSTEM).toContain("the reason for each");
    // Supersession is what makes a decision history usable rather than a
    // pile of equally-live claims.
    expect(SUMMARIZE_SYSTEM).toMatch(/superseded|invalidated|ruled out/);
    expect(SUMMARIZE_SYSTEM).toContain("remain true");
    expect(SUMMARIZE_SYSTEM).toMatch(/questions still open/);
  });

  it("requires causal phrasing explicitly, so a fact list is insufficient", () => {
    expect(SUMMARIZE_SYSTEM).toMatch(/causal phrasing/i);
    expect(SUMMARIZE_SYSTEM).toContain(
      "not how it came to be true is not sufficient",
    );
  });

  it("keeps the summary bounded, because it is injected into context", () => {
    expect(SUMMARIZE_SYSTEM).toMatch(/at most 6/);
  });

  it("still demands summary-only output (no preamble to strip)", () => {
    expect(SUMMARIZE_SYSTEM).toContain("ONLY");
  });
});

describe("summarizeDroppedMessages sends that instruction", () => {
  it("uses SUMMARIZE_SYSTEM as the system message", async () => {
    const model = new FakeModel([textResponse("summary text")]);
    const agent = makeAgent(model);
    const summary = await summarizeDroppedMessages(agent, [
      { role: "user", content: [{ type: "text", text: "earlier turn" }] },
    ]);

    expect(summary).toBe("summary text");
    expect(model.calls).toHaveLength(1);
    const system = model.calls[0]?.messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content[0]).toMatchObject({
      type: "text",
      text: SUMMARIZE_SYSTEM,
    });
  });

  it("passes the dropped messages through as the user turn", async () => {
    const model = new FakeModel([textResponse("s")]);
    const agent = makeAgent(model);
    await summarizeDroppedMessages(agent, [
      { role: "user", content: [{ type: "text", text: "DROPPED-MARKER" }] },
    ]);
    const user = model.calls[0]?.messages[1];
    expect(user?.role).toBe("user");
    expect(JSON.stringify(user?.content)).toContain("DROPPED-MARKER");
  });
});

describe("the REPL /compact --summarize uses the same instruction", () => {
  it("sends SUMMARIZE_SYSTEM, not a private copy", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "envoy-summary-"));
    try {
      // Enough messages that `keep: 20` actually drops some.
      const session = new InMemorySession(newSessionId(), {
        cwd: dir,
        permissionMode: "read-only",
        startedAt: new Date().toISOString(),
      });
      for (let i = 0; i < 25; i += 1) {
        session.appendMessage("user", [
          { type: "text", text: `message ${i}` },
        ]);
      }

      const model = new FakeModel([textResponse("the summary")]);
      await runRepl({
        model,
        args: makeArgs(),
        lineReader: fakeLineReader(["/compact --summarize", "/quit"]),
        createSession: async () => session,
        stdout: new StringWritable(),
        stderr: new StringWritable(),
        historyPath: "",
      });

      // The only model call is the summarizer's.
      expect(model.calls).toHaveLength(1);
      const system = model.calls[0]?.messages[0];
      expect(system?.role).toBe("system");
      expect(system?.content[0]).toMatchObject({
        type: "text",
        text: SUMMARIZE_SYSTEM,
      });
    } finally {
      await removeTempDir(dir);
    }
  });
});
