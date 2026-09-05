/**
 * R4.2 — retained context across compaction.
 */
import { describe, expect, it } from "vitest";

import {
  Agent,
  InMemorySession,
  RetainedContextStore,
  ToolRegistry,
  injectRetainedContext,
  newSessionId,
} from "../src/index.js";
import {
  FakeModel,
  textResponse,
} from "./fixtures/fake-model.js";
import type { Message } from "../src/tools/types.js";

function sys(text: string): Message {
  return { role: "system", content: [{ type: "text", text }] };
}
function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistant(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("RetainedContextStore", () => {
  it("evicts oldest when over token budget", () => {
    const store = new RetainedContextStore({ tokenBudget: 20 });
    store.add({ text: "aaaaaaaaaaaaaaaaaaaaaaaa", kind: "fact" });
    store.add({ text: "bbbbbbbbbbbbbbbbbbbbbbbb", kind: "fact" });
    expect(store.list().length).toBeLessThanOrEqual(2);
    expect(store.estimatedTokens()).toBeLessThanOrEqual(20);
  });

  it("injectRetainedContext places block after system", () => {
    const store = new RetainedContextStore();
    store.add({ text: "user prefers tabs", kind: "user_answer" });
    const out = injectRetainedContext(
      [sys("S"), user("u1"), assistant("a1")],
      store,
    );
    expect(out[0]).toEqual(sys("S"));
    expect(out[1]?.role).toBe("user");
    expect(
      out[1]?.content[0]?.type === "text" &&
        out[1].content[0].text.includes("user prefers tabs"),
    ).toBe(true);
  });
});

describe("Agent.compact preserves retained context", () => {
  it("re-injects retained facts after drop-oldest compact", () => {
    const session = new InMemorySession(newSessionId(), {
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    });
    session.appendMessage("system", [{ type: "text", text: "S" }]);
    session.appendMessage("user", [{ type: "text", text: "u1" }]);
    session.appendMessage("assistant", [{ type: "text", text: "a1" }]);
    session.appendMessage("user", [{ type: "text", text: "u2" }]);
    session.appendMessage("assistant", [{ type: "text", text: "a2" }]);

    const agent = new Agent({
      model: new FakeModel([textResponse("ok")]),
      tools: new ToolRegistry(),
      session,
      cwd: "/tmp",
    });
    agent.retainContext({
      text: "API key is in .env.local",
      kind: "fact",
    });
    agent.compact(2);

    const texts = session.messages.flatMap((m) =>
      m.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : "")),
    );
    expect(texts.some((t) => t.includes("API key is in .env.local"))).toBe(
      true,
    );
    expect(texts.some((t) => t === "u1")).toBe(false);
    expect(texts.some((t) => t === "u2")).toBe(true);
  });
});
