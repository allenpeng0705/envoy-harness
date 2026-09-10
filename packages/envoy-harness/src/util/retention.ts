/**
 * Byte-accurate, UTF-8-safe output retention.
 *
 * **Why this module exists.** envoy capped tool output in seven places,
 * each with its own ad-hoc `slice`/`subarray` + string concatenation.
 * Three of them produced **invalid text**:
 *
 * - `tools/builtin/bash.ts` sliced a JS string by code units, which can
 *   split a surrogate pair and leave a lone surrogate in the transcript.
 * - `tools/builtin/read-file.ts`, `exec-world/{local,peer}.ts`,
 *   `jobs/registry.ts`, and `web/fetch-http.ts` cut a `Buffer` at an
 *   arbitrary byte and then decoded it, which emits U+FFFD at the seam.
 *
 * A lone surrogate or a replacement character is not cosmetic: it lands
 * in the model's context and in the durable session log, and it makes
 * byte/char accounting disagree with what the tool actually produced.
 *
 * **The invariant this module guarantees:** the returned text never
 * contains a codepoint that the original did not, and never contains a
 * partial one — for any cut position, any strategy, any input.
 *
 * **The subtle rule.** When a head+tail window covers the whole input
 * there is no omitted gap, so the join between head and tail is
 * *artificial* and a codepoint may legitimately span it. In that case
 * the two sides are concatenated as bytes and decoded once. Only a real
 * omitted gap causes the sides to be trimmed and decoded separately —
 * a codepoint is never reconstructed across bytes that were dropped.
 *
 * Everything here is pure and dependency-free, so it is cheap to test
 * exhaustively and safe to call on any hot path.
 */

/** How much of an input to keep. */
export type RetentionStrategy =
  | { readonly kind: "head"; readonly maxBytes: number }
  | { readonly kind: "tail"; readonly maxBytes: number }
  | {
      readonly kind: "headTail";
      readonly headBytes: number;
      readonly tailBytes: number;
    };

/** What was dropped, when it can be known exactly. */
export type Omitted =
  | { readonly kind: "none" }
  | { readonly kind: "exact"; readonly count: number }
  | { readonly kind: "unknown" };

export interface RetentionResult {
  /** The retained text (already decoded, always valid). */
  readonly text: string;
  /** How much was dropped, measured in bytes of the original. */
  readonly omitted: Omitted;
  /** Byte length of the original input. */
  readonly originalBytes: number;
  /**
   * Bytes of the ORIGINAL that were kept. For `headTail` with a real
   * gap this is `head.length + tail.length` and therefore does NOT
   * equal `utf8ByteLength(text)` — the rendered text also carries the
   * `…` join marker.
   */
  readonly retainedBytes: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** Byte length of a string in UTF-8 (cheaper than re-encoding). */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Encode a string to UTF-8 bytes (thin wrapper, keeps one encoder). */
export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

function decode(bytes: Uint8Array): string {
  // A zero-length decode still yields "" — no special case needed.
  return decoder.decode(bytes);
}

function assertBudget(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

/**
 * Drop a trailing partial UTF-8 sequence from the end of `bytes`.
 *
 * Walks back over at most three continuation bytes to find the lead
 * byte, then checks whether the whole sequence is present. An invalid
 * lead byte is dropped too — a cut in the middle of malformed input
 * must not smuggle a byte we cannot interpret.
 */
export function trimTrailingPartialUtf8(bytes: Uint8Array): Uint8Array {
  const end = bytes.length;
  let i = end;
  while (i > 0 && (bytes[i - 1]! & 0xc0) === 0x80) {
    i -= 1;
    // A run longer than 3 continuation bytes cannot belong to one
    // sequence; treat the whole run as unusable.
    if (end - i > 3) return bytes.subarray(0, i);
  }
  if (i === 0) return bytes.subarray(0, 0);
  const lead = bytes[i - 1]!;
  const expected =
    lead < 0x80 ? 1 : lead < 0xc0 ? 0 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 0;
  if (expected === 0) return bytes.subarray(0, i - 1);
  return end - (i - 1) < expected ? bytes.subarray(0, i - 1) : bytes.subarray(0, end);
}

/** Drop leading continuation bytes (the tail of a split sequence). */
export function trimLeadingContinuationUtf8(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length && (bytes[i]! & 0xc0) === 0x80) i += 1;
  return bytes.subarray(i);
}

function none(original: Uint8Array): RetentionResult {
  return {
    text: decode(original),
    omitted: { kind: "none" },
    originalBytes: original.length,
    retainedBytes: original.length,
  };
}

/** Retain a byte buffer according to `strategy`. */
export function retainBytes(
  bytes: Uint8Array,
  strategy: RetentionStrategy,
): RetentionResult {
  if (strategy.kind === "head") {
    assertBudget("maxBytes", strategy.maxBytes);
    if (bytes.length <= strategy.maxBytes) return none(bytes);
    const kept = trimTrailingPartialUtf8(bytes.subarray(0, strategy.maxBytes));
    return {
      text: decode(kept),
      omitted: { kind: "exact", count: bytes.length - kept.length },
      originalBytes: bytes.length,
      retainedBytes: kept.length,
    };
  }

  if (strategy.kind === "tail") {
    assertBudget("maxBytes", strategy.maxBytes);
    if (bytes.length <= strategy.maxBytes) return none(bytes);
    const kept = trimLeadingContinuationUtf8(
      bytes.subarray(bytes.length - strategy.maxBytes),
    );
    return {
      text: decode(kept),
      omitted: { kind: "exact", count: bytes.length - kept.length },
      originalBytes: bytes.length,
      retainedBytes: kept.length,
    };
  }

  assertBudget("headBytes", strategy.headBytes);
  assertBudget("tailBytes", strategy.tailBytes);
  const total = strategy.headBytes + strategy.tailBytes;
  // The window covers everything: nothing is omitted, so the join is
  // artificial and must be decoded as one buffer.
  if (total >= bytes.length) return none(bytes);

  const head = trimTrailingPartialUtf8(bytes.subarray(0, strategy.headBytes));
  const tail = trimLeadingContinuationUtf8(
    bytes.subarray(bytes.length - strategy.tailBytes),
  );
  const omittedCount = bytes.length - head.length - tail.length;
  if (omittedCount <= 0) return none(bytes);
  return {
    text: `${decode(head)}…${decode(tail)}`,
    omitted: { kind: "exact", count: omittedCount },
    originalBytes: bytes.length,
    retainedBytes: head.length + tail.length,
  };
}

/** Retain a string according to `strategy` (encodes to bytes first). */
export function retainText(
  text: string,
  strategy: RetentionStrategy,
): RetentionResult {
  return retainBytes(encoder.encode(text), strategy);
}

/** Human-readable notice for an omission. Empty string when nothing was. */
export function formatRetentionNotice(omitted: Omitted): string {
  switch (omitted.kind) {
    case "none":
      return "";
    case "exact":
      return `[truncated: ${omitted.count} bytes omitted]`;
    case "unknown":
      return "[truncated: additional output omitted]";
  }
}

/** Notice plus the retained text, ready to hand to a tool result. */
export function applyRetention(
  text: string,
  strategy: RetentionStrategy,
  options: { readonly separator?: string } = {},
): string {
  const result = retainText(text, strategy);
  const notice = formatRetentionNotice(result.omitted);
  if (notice.length === 0) return result.text;
  return `${result.text}${options.separator ?? "\n"}${notice}`;
}

/**
 * The one call site helper for byte caps: decode at most `maxBytes`
 * without ever emitting a partial codepoint.
 *
 * Replaces the `buf.subarray(0, cap).toString("utf8")` pattern, which
 * yields U+FFFD whenever the cut lands mid-sequence.
 */
export function decodeUtf8Within(
  bytes: Uint8Array,
  maxBytes: number,
): { text: string; truncated: boolean; byteLength: number } {
  assertBudget("maxBytes", maxBytes);
  if (bytes.length <= maxBytes) {
    return { text: decode(bytes), truncated: false, byteLength: bytes.length };
  }
  const kept = trimTrailingPartialUtf8(bytes.subarray(0, maxBytes));
  return { text: decode(kept), truncated: true, byteLength: bytes.length };
}

/**
 * Head-truncate a string for a labelled stream (`stdout`, `stderr`, …).
 *
 * The drop-in replacement for the `text.slice(0, cap) + "\n[label
 * truncated]"` idiom, which cut by UTF-16 code unit and could leave a
 * lone surrogate behind.
 */
export function retainHeadBytes(
  text: string,
  maxBytes: number,
  label: string,
): string {
  const decoded = decodeUtf8Within(encoder.encode(text), maxBytes);
  return decoded.truncated
    ? `${decoded.text}\n[${label} truncated]`
    : decoded.text;
}

/**
 * Character-safe truncation for the places that cap by characters
 * rather than bytes (`message-format`, `activity-format`).
 *
 * Never splits a surrogate pair: if the cut would leave a high
 * surrogate stranded at the end (with its low surrogate beyond the
 * cut), the cut backs off by one unit.
 */
export function truncateChars(text: string, maxChars: number): string {
  assertBudget("maxChars", maxChars);
  if (text.length <= maxChars) return text;
  if (maxChars === 0) return "";
  let end = maxChars - 1; // reserve one char for the ellipsis
  const lastKept = text.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
  return `${text.slice(0, Math.max(0, end))}…`;
}
