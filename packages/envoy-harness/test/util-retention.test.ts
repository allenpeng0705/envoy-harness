/**
 * UTF-8-safe output retention — hermetic unit tests.
 *
 * Pure functions, no filesystem, no network. The whole point of this
 * module is boundary correctness, so the tests are exhaustive over the
 * ways a byte cut can go wrong rather than representative.
 */

import { describe, expect, it } from "vitest";

import {
  applyRetention,
  decodeUtf8Within,
  encodeUtf8,
  formatRetentionNotice,
  retainBytes,
  retainHeadBytes,
  retainText,
  trimLeadingContinuationUtf8,
  trimTrailingPartialUtf8,
  truncateChars,
  utf8ByteLength,
} from "../src/util/retention.js";

const REPLACEMENT = "\uFFFD";
/** True if the string contains a lone (unpaired) surrogate. */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Assert the universal invariant for every retention result. */
function expectValid(text: string): void {
  expect(text.includes(REPLACEMENT)).toBe(false);
  expect(hasLoneSurrogate(text)).toBe(false);
}

describe("trimTrailingPartialUtf8", () => {
  it("drops a partial 2-byte sequence", () => {
    // "é" = C3 A9; cut after the lead byte.
    expect([...trimTrailingPartialUtf8(Uint8Array.from([0x61, 0xc3]))]).toEqual([0x61]);
  });

  it("drops a partial 3-byte sequence", () => {
    // "€" = E2 82 AC; keep lead + one continuation.
    expect([
      ...trimTrailingPartialUtf8(Uint8Array.from([0x61, 0xe2, 0x82])),
    ]).toEqual([0x61]);
  });

  it("drops a partial 4-byte sequence", () => {
    // "😀" = F0 9F 98 80; keep three of four bytes.
    expect([
      ...trimTrailingPartialUtf8(Uint8Array.from([0x61, 0xf0, 0x9f, 0x98])),
    ]).toEqual([0x61]);
  });

  it("keeps a complete sequence", () => {
    const bytes = Uint8Array.from([0xe2, 0x82, 0xac]);
    expect([...trimTrailingPartialUtf8(bytes)]).toEqual([0xe2, 0x82, 0xac]);
  });

  it("leaves an over-long continuation run alone past the limit", () => {
    // Four continuation bytes cannot belong to one sequence.
    const bytes = Uint8Array.from([0x61, 0x80, 0x80, 0x80, 0x80]);
    const out = trimTrailingPartialUtf8(bytes);
    expect(out.length).toBeLessThanOrEqual(bytes.length);
    expect([...out]).toEqual([0x61]);
  });

  it("drops an invalid lead byte", () => {
    expect([...trimTrailingPartialUtf8(Uint8Array.from([0x61, 0xf8]))]).toEqual([0x61]);
  });

  it("handles empty input", () => {
    expect(trimTrailingPartialUtf8(Uint8Array.from([])).length).toBe(0);
  });
});

describe("trimLeadingContinuationUtf8", () => {
  it("drops a leading continuation run", () => {
    expect([
      ...trimLeadingContinuationUtf8(Uint8Array.from([0x80, 0x80, 0x7a])),
    ]).toEqual([0x7a]);
  });

  it("keeps a lead byte", () => {
    expect([
      ...trimLeadingContinuationUtf8(Uint8Array.from([0xe2, 0x82, 0xac])),
    ]).toEqual([0xe2, 0x82, 0xac]);
  });
});

describe("retainBytes — head", () => {
  it("returns everything when under budget", () => {
    const result = retainBytes(encodeUtf8("hi"), { kind: "head", maxBytes: 10 });
    expect(result.text).toBe("hi");
    expect(result.omitted).toEqual({ kind: "none" });
  });

  it("never emits a replacement char at the cut", () => {
    const text = `${"a".repeat(9)}€${"b".repeat(10)}`;
    for (let cap = 0; cap < utf8ByteLength(text); cap++) {
      const result = retainBytes(encodeUtf8(text), { kind: "head", maxBytes: cap });
      expectValid(result.text);
    }
  });

  it("reports omission against bytes actually returned", () => {
    // "a€b" is 5 bytes. A cap of 2 lands inside the 3-byte "€", so the
    // boundary trim drops the whole sequence: 1 byte kept, 4 omitted —
    // NOT the 3 a budget-derived count would report.
    const text = `a€b`;
    const result = retainBytes(encodeUtf8(text), { kind: "head", maxBytes: 2 });
    expect(result.text).toBe("a");
    expect(result.retainedBytes).toBe(1);
    expect(result.omitted).toEqual({ kind: "exact", count: 4 });
    // The invariant that ties the report to reality:
    expect(utf8ByteLength(result.text)).toBe(result.retainedBytes);
    expect(result.originalBytes - result.retainedBytes).toBe(4);
  });

  it("accepts maxBytes 0", () => {
    const result = retainBytes(encodeUtf8("abc"), { kind: "head", maxBytes: 0 });
    expect(result.text).toBe("");
    expect(result.omitted).toEqual({ kind: "exact", count: 3 });
  });

  it("rejects a negative or fractional budget", () => {
    expect(() => retainBytes(encodeUtf8("a"), { kind: "head", maxBytes: -1 })).toThrow(
      /non-negative integer/,
    );
    expect(() =>
      retainBytes(encodeUtf8("a"), { kind: "head", maxBytes: 1.5 }),
    ).toThrow(/non-negative integer/);
  });
});

describe("retainBytes — tail", () => {
  it("never emits a leading continuation byte", () => {
    const text = `abc€def`;
    for (let cap = 0; cap < utf8ByteLength(text); cap++) {
      const result = retainBytes(encodeUtf8(text), { kind: "tail", maxBytes: cap });
      expectValid(result.text);
    }
  });

  it("keeps the end of the input", () => {
    const result = retainBytes(encodeUtf8("abcdef"), { kind: "tail", maxBytes: 3 });
    expect(result.text).toBe("def");
  });
});

describe("retainBytes — headTail", () => {
  it("treats a window covering everything as an artificial split", () => {
    // The window spans the whole input, so no bytes are omitted and a
    // codepoint straddling the join must survive intact.
    const text = `ab€cd`;
    const total = utf8ByteLength(text);
    const result = retainBytes(encodeUtf8(text), {
      kind: "headTail",
      headBytes: total,
      tailBytes: total,
    });
    expect(result.omitted).toEqual({ kind: "none" });
    expect(result.text).toBe(text);
    expectValid(result.text);
  });

  it("keeps a boundary-spanning codepoint when head+tail covers the input", () => {
    const text = `aaa€bbb`; // 9 bytes: 3 + 3 + 3
    // head 5 lands mid-€; tail 4 also lands mid-€, but together they
    // cover everything, so the codepoint must be reconstructed.
    const result = retainBytes(encodeUtf8(text), {
      kind: "headTail",
      headBytes: 5,
      tailBytes: 4,
    });
    expect(result.text).toBe(text);
    expect(result.omitted).toEqual({ kind: "none" });
  });

  it("trims both sides — and never reconstructs across — a real gap", () => {
    const text = `${"a".repeat(4)}${"€".repeat(4)}${"b".repeat(4)}`;
    const result = retainBytes(encodeUtf8(text), {
      kind: "headTail",
      headBytes: 5,
      tailBytes: 5,
    });
    expect(result.omitted.kind).toBe("exact");
    expectValid(result.text);
    expect(result.text).toContain("…");
    // A codepoint is never rebuilt out of dropped bytes.
    expect(result.text.startsWith("aaaa")).toBe(true);
    expect(result.text.endsWith("bbbb")).toBe(true);
  });

  it("uses the finest-grained boundary it can for every cut position", () => {
    const text = `x${"€".repeat(6)}y${"😀".repeat(3)}z`;
    const bytes = encodeUtf8(text);
    for (let head = 0; head < bytes.length; head += 1) {
      for (let tail = 0; tail < bytes.length; tail += 4) {
        const result = retainBytes(bytes, { kind: "headTail", headBytes: head, tailBytes: tail });
        expectValid(result.text);
        // Whatever was kept never exceeds the original, and the omission
        // report is exactly the difference.
        expect(result.retainedBytes).toBeLessThanOrEqual(result.originalBytes);
        if (result.omitted.kind === "exact") {
          expect(result.originalBytes - result.retainedBytes).toBe(
            result.omitted.count,
          );
        } else {
          // The window covered the whole input: nothing omitted.
          expect(result.omitted).toEqual({ kind: "none" });
          expect(result.retainedBytes).toBe(result.originalBytes);
          expect(result.text).toBe(text);
        }
      }
    }
  });
});

describe("decodeUtf8Within", () => {
  it("passes short input through untouched", () => {
    const decoded = decodeUtf8Within(encodeUtf8("hello"), 32);
    expect(decoded).toEqual({ text: "hello", truncated: false, byteLength: 5 });
  });

  it("never yields U+FFFD across a multi-byte cut", () => {
    // This is the exact defect the helper replaces:
    // `buf.subarray(0, cap).toString("utf8")`.
    const buf = encodeUtf8(`hello€world`);
    const naive = Buffer.from(buf).subarray(0, 6).toString("utf8");
    expect(naive).toContain(REPLACEMENT);

    const decoded = decodeUtf8Within(buf, 6);
    expect(decoded.text).toBe("hello");
    expect(decoded.truncated).toBe(true);
    expect(decoded.byteLength).toBe(utf8ByteLength("hello€world"));
  });
});

describe("retainHeadBytes (the bash-style helper)", () => {
  it("appends the labelled notice only when truncated", () => {
    expect(retainHeadBytes("abc", 16, "stdout")).toBe("abc");
    expect(retainHeadBytes("abcdef", 3, "stdout")).toBe("abc\n[stdout truncated]");
  });

  it("does not split a surrogate pair", () => {
    const emoji = "😀".repeat(4); // 16 bytes, 8 code units
    const out = retainHeadBytes(emoji, 9, "stdout");
    expectValid(out);
  });
});

describe("applyRetention / formatRetentionNotice", () => {
  it("renders a notice only when something was dropped", () => {
    expect(formatRetentionNotice({ kind: "none" })).toBe("");
    expect(formatRetentionNotice({ kind: "exact", count: 42 })).toBe(
      "[truncated: 42 bytes omitted]",
    );
    expect(formatRetentionNotice({ kind: "unknown" })).toContain("omitted");
  });

  it("returns the text unchanged when nothing is dropped", () => {
    expect(applyRetention("short", { kind: "head", maxBytes: 100 })).toBe("short");
  });

  it("joins the notice with the configured separator", () => {
    expect(
      applyRetention("abcdef", { kind: "head", maxBytes: 3 }, { separator: " | " }),
    ).toBe("abc | [truncated: 3 bytes omitted]");
  });
});

describe("truncateChars", () => {
  it("returns short strings unchanged", () => {
    expect(truncateChars("abc", 10)).toBe("abc");
  });

  it("never splits a surrogate pair", () => {
    // Cut lands exactly between the high and low surrogate.
    const text = "ab😀cd";
    for (let max = 1; max < text.length; max++) {
      expectValid(truncateChars(text, max));
    }
  });

  it("handles maxChars 0 and 1", () => {
    expect(truncateChars("hello", 0)).toBe("");
    expect(truncateChars("hello", 1)).toBe("…");
  });
});

describe("retainText", () => {
  it("agrees with retainBytes over the encoded form", () => {
    const text = `abc€😀def`;
    const strategy = { kind: "headTail", headBytes: 4, tailBytes: 4 } as const;
    const viaText = retainText(text, strategy);
    const viaBytes = retainBytes(encodeUtf8(text), strategy);
    expect(viaText).toEqual(viaBytes);
    expectValid(viaText.text);
  });

  it("is stable under a round trip through UTF-8", () => {
    const text = `${"🙂".repeat(50)}`;
    const strategy = { kind: "tail", maxBytes: 20 } as const;
    const once = retainText(text, strategy);
    const twice = retainText(once.text, strategy);
    expect(twice.text).toBe(once.text);
  });
});
