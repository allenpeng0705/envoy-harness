/**
 * U2 — composer keymaps: typing, editing, history, slash completion,
 * cancel/eof actions.
 */

import { describe, expect, it } from "vitest";

import { Composer, completeSlash } from "../src/composer.js";

function key(name: string, extra: Record<string, boolean> = {}): {
  name: string;
  ctrl?: boolean;
  meta?: boolean;
} {
  return { name, ...extra };
}

describe("Composer", () => {
  it("types printable characters at the cursor and submits on Enter", () => {
    const c = new Composer();
    c.handleKey("h", key(""));
    c.handleKey("i", key(""));
    expect(c.buffer).toBe("hi");
    const action = c.handleKey(undefined, key("return"));
    expect(action).toEqual({ type: "submit", line: "hi" });
    expect(c.buffer).toBe("");
  });

  it("backspace deletes at the cursor and left/right move it", () => {
    const c = new Composer();
    for (const ch of "abc") c.handleKey(ch, key(""));
    c.handleKey(undefined, key("left"));
    c.handleKey(undefined, key("backspace"));
    expect(c.buffer).toBe("ac");
    expect(c.cursor).toBe(1);
    c.handleKey("X", key(""));
    expect(c.buffer).toBe("aXc");
  });

  it("keeps history and navigates with up/down arrows", () => {
    const c = new Composer();
    for (const ch of "one") c.handleKey(ch, key(""));
    c.handleKey(undefined, key("return"));
    for (const ch of "two") c.handleKey(ch, key(""));
    c.handleKey(undefined, key("return"));
    expect(c.history).toEqual(["one", "two"]);
    c.handleKey(undefined, key("up"));
    expect(c.buffer).toBe("two");
    c.handleKey(undefined, key("up"));
    expect(c.buffer).toBe("one");
    c.handleKey(undefined, key("down"));
    expect(c.buffer).toBe("two");
  });

  it("maps Esc and Ctrl-C to cancel and Ctrl-D to eof", () => {
    const c = new Composer();
    expect(c.handleKey(undefined, key("escape"))).toEqual({ type: "cancel" });
    expect(c.handleKey(undefined, key("c", { ctrl: true }))).toEqual({
      type: "cancel",
    });
    expect(c.handleKey(undefined, key("d", { ctrl: true }))).toEqual({
      type: "eof",
    });
  });

  it("Ctrl-U clears the buffer", () => {
    const c = new Composer();
    for (const ch of "abc") c.handleKey(ch, key(""));
    expect(c.handleKey(undefined, key("u", { ctrl: true }))).toEqual({
      type: "change",
    });
    expect(c.buffer).toBe("");
  });

  it("inserts Alt+char sequences (Esc quickly followed by a char) as printable", () => {
    const c = new Composer();
    // emitKeypressEvents parses "\x1b/" as one meta keypress.
    c.handleKey(undefined, { sequence: "\x1b/", meta: true });
    c.handleKey("r", { sequence: "r", name: "r" });
    expect(c.buffer).toBe("/r");
  });

  it("ignores empty submits and does not duplicate consecutive history", () => {
    const c = new Composer();
    expect(c.handleKey(undefined, key("return"))).toEqual({ type: "change" });
    c.handleKey("x", key(""));
    c.handleKey(undefined, key("return"));
    c.handleKey("x", key(""));
    c.handleKey(undefined, key("return"));
    expect(c.history).toEqual(["x"]);
  });
});

describe("completeSlash", () => {
  it("completes a slash prefix to the first matching command", () => {
    expect(completeSlash("/sc")).toBe("/scoreboard");
    expect(completeSlash("/clu")).toBe("/cluster");
  });

  it("adds a trailing space when the buffer is already an exact command", () => {
    expect(completeSlash("/cluster")).toBe("/cluster ");
  });

  it("leaves non-slash input and unknown prefixes unchanged", () => {
    expect(completeSlash("hello")).toBe("hello");
    expect(completeSlash("/zzz")).toBe("/zzz");
  });
});
