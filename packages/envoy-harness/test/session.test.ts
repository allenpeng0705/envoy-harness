/**
 * InMemorySession tests (§3.2 of the design).
 *
 * Covers the append-only transcript, id/metadata stability,
 * and the lastMessage / clear utilities.
 */

import { describe, expect, it } from "vitest";

import {
  InMemorySession,
  newSessionId,
  type Session,
  type SessionMetadata,
} from "../src/index.js";

function makeSession(): Session {
  const metadata: SessionMetadata = {
    cwd: "/tmp",
    title: "test session",
    permissionMode: "read-only",
    startedAt: new Date().toISOString(),
  };
  return new InMemorySession(newSessionId(), metadata);
}

describe("InMemorySession: id and metadata", () => {
  it("id is stable across the session's lifetime", () => {
    const s = makeSession();
    const idBefore = s.id;
    s.appendMessage("user", [{ type: "text", text: "hi" }]);
    expect(s.id).toBe(idBefore);
  });

  it("metadata is read-only and reflects the constructor input", () => {
    const meta: SessionMetadata = {
      cwd: "/home/user",
      permissionMode: "workspace-write",
      startedAt: "2026-01-01T00:00:00Z",
    };
    const s = new InMemorySession("fixed-id", meta);
    expect(s.id).toBe("fixed-id");
    expect(s.metadata).toBe(meta);
    // `metadata` is readonly; the field is the same reference.
    expect(s.metadata.cwd).toBe("/home/user");
  });
});

describe("InMemorySession: append and retrieve", () => {
  it("starts with an empty transcript", () => {
    const s = makeSession();
    expect(s.messages).toHaveLength(0);
    expect(s.lastMessage()).toBeNull();
  });

  it("appendMessage adds to the transcript and returns the new length", () => {
    const s = makeSession();
    const len1 = s.appendMessage("user", [{ type: "text", text: "hi" }]);
    expect(len1).toBe(1);
    expect(s.messages).toHaveLength(1);
    const len2 = s.appendMessage(
      "assistant",
      [{ type: "text", text: "hello" }],
    );
    expect(len2).toBe(2);
  });

  it("preserves the role and content of each message", () => {
    const s = makeSession();
    s.appendMessage("user", [{ type: "text", text: "what's 2+2?" }]);
    s.appendMessage("assistant", [
      { type: "text", text: "4" },
      { type: "tool_call", id: "tc1", name: "sum", args: { a: 2, b: 2 } },
    ]);
    s.appendMessage("tool", [
      { type: "tool_result", toolCallId: "tc1", content: 4, isError: false },
    ]);
    const m = s.messages;
    expect(m[0]?.role).toBe("user");
    expect(m[0]?.content[0]).toEqual({ type: "text", text: "what's 2+2?" });
    expect(m[1]?.role).toBe("assistant");
    expect(m[1]?.content[0]).toEqual({ type: "text", text: "4" });
    expect(m[2]?.role).toBe("tool");
  });

  it("lastMessage() returns the most recent message or null", () => {
    const s = makeSession();
    expect(s.lastMessage()).toBeNull();
    s.appendMessage("user", [{ type: "text", text: "hi" }]);
    const last = s.lastMessage();
    expect(last).not.toBeNull();
    expect(last?.role).toBe("user");
  });

  it("content blocks are copied (caller can't mutate the transcript)", () => {
    // This guards against a subtle bug: if appendMessage stored
    // the array reference, the caller could mutate it after the
    // fact. The contract is that messages are immutable post-append.
    const s = makeSession();
    const blocks = [{ type: "text" as const, text: "hi" }];
    s.appendMessage("user", blocks);
    // Mutate the caller's reference.
    blocks.push({ type: "text" as const, text: "extra" });
    // The session's copy is unaffected.
    expect(s.messages[0]?.content).toHaveLength(1);
  });
});

describe("InMemorySession: clear", () => {
  it("removes all messages but keeps id and metadata", () => {
    const s = makeSession();
    const idBefore = s.id;
    const metaBefore = s.metadata;
    s.appendMessage("user", [{ type: "text", text: "hi" }]);
    s.clear();
    expect(s.messages).toHaveLength(0);
    expect(s.lastMessage()).toBeNull();
    // Id and metadata survive.
    expect(s.id).toBe(idBefore);
    expect(s.metadata).toBe(metaBefore);
  });
});

describe("newSessionId", () => {
  it("returns a non-empty string", () => {
    const id = newSessionId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("returns different ids on subsequent calls", () => {
    // 100 calls should produce 100 distinct ids. With UUIDv4
    // the collision probability is ~ 2^-122, so a single dup
    // would be a major bug.
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(newSessionId());
    expect(ids.size).toBe(100);
  });
});
