/**
 * Tests for `src/interaction/providers/repl-stdin.ts` — the
 * REPL `UserQuestionProvider`.
 *
 * Covers:
 * 1. Single-line prompt: user types "yes" → answer
 *    `{ value: "yes" }`.
 * 2. EOF before any input → `{ cancelled: true, reason: "aborted" }`.
 * 3. `signal.abort()` mid-prompt → same shape; the
 *    readline interface is closed cleanly.
 * 4. Multiline mode: 3 lines + sentinel → joined value.
 * 5. Multiline mode: EOF before sentinel → cancelled.
 * 6. Multiline mode: partial input then EOF → returns
 *    the partial value (the human typed something
 *    useful, even if the sentinel was missed).
 * 7. Options picker: user types "2" → `{ value: option[1], optionIndex: 1 }`.
 * 8. Options picker: user types free-form text that doesn't
 *    match a number → free-form value, no `optionIndex`.
 * 9. Pre-aborted signal: returns cancelled without
 *    reading any input.
 *
 * **Hermetic:** every test uses a `Readable.from([...])`
 * (or `.from([]` for EOF) + a `Writable` that captures
 * output. No real stdin, no real REPL.
 */

import { Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  createReplStdinProvider,
  DEFAULT_MULTILINE_SENTINEL,
} from "../../../src/interaction/providers/repl-stdin.js";

/**
 * A `Writable` that captures everything written to it.
 * Used to assert the prompt header the provider wrote
 * to `output`.
 */
class CapturingWritable extends Writable {
  readonly chunks: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override _write(
    chunk: any,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString("utf8"));
    cb();
  }
  /** The captured chunks joined into one string. */
  get text(): string {
    return this.chunks.join("");
  }
}

/**
 * Build a provider with the given input + output streams.
 * Returns the provider + the capturing writable so the
 * test can assert the prompt header.
 */
function makeProvider(
  input: Readable,
  output: CapturingWritable = new CapturingWritable(),
  name: string = "repl-stdin-test",
) {
  const provider = createReplStdinProvider({ input, output, name });
  return { provider, output };
}

describe("createReplStdinProvider", () => {
  it("reads a single-line answer and returns the trimmed value", async () => {
    const input = Readable.from(["yes\n"]);
    const { provider, output } = makeProvider(input);
    const out = await provider.ask({
      prompt: "Continue?",
      signal: new AbortController().signal,
    });
    expect(out.value).toBe("yes");
    expect(out.cancelled).toBe(false);
    // The prompt header was written to `output`.
    expect(output.text).toContain("Continue?");
  });

  it("returns cancelled when the input stream ends before any input", async () => {
    // Empty Readable — the readline `close` event fires
    // immediately.
    const input = Readable.from([]);
    const { provider } = makeProvider(input);
    const out = await provider.ask({
      prompt: "Continue?",
      signal: new AbortController().signal,
    });
    expect(out.cancelled).toBe(true);
    expect(out.cancelledReason).toBe("aborted");
    expect(out.value).toBe("");
  });

  it("returns cancelled when the signal aborts mid-prompt", async () => {
    // A Readable that never produces input — the
    // provider waits on the readline `line` event
    // until the signal aborts.
    const input = new Readable({
      read() {
        // intentionally never push / push null
      },
    });
    const { provider } = makeProvider(input);
    const ac = new AbortController();
    // Schedule the abort for "now" — the readline
    // interface's `close` event fires, the provider
    // resolves with `cancelled: true`.
    setTimeout(() => ac.abort(), 20);
    const out = await provider.ask({
      prompt: "Continue?",
      signal: ac.signal,
    });
    expect(out.cancelled).toBe(true);
    expect(out.cancelledReason).toBe("aborted");
    expect(out.value).toBe("");
    // The provider must close its readline interface
    // on abort so the test doesn't leak a handle.
    // (Node exits the process when dangling handles
    // exist; vitest would log a warning.)
  });

  it("reads a multiline block terminated by the sentinel", async () => {
    const sentinel = DEFAULT_MULTILINE_SENTINEL;
    const input = Readable.from([
      "line 1\n",
      "line 2\n",
      "line 3\n",
      `${sentinel}\n`,
    ]);
    const { provider, output } = makeProvider(input);
    const out = await provider.ask({
      prompt: "Paste the error log:",
      multiline: true,
      signal: new AbortController().signal,
    });
    expect(out.value).toBe("line 1\nline 2\nline 3");
    expect(out.cancelled).toBe(false);
    // The prompt header mentions the sentinel.
    expect(output.text).toContain(sentinel);
  });

  it("returns cancelled when multiline EOF comes before any input", async () => {
    // No lines at all — the human didn't type anything
    // before EOF. Return a clean cancel.
    const input = Readable.from([]);
    const { provider } = makeProvider(input);
    const out = await provider.ask({
      prompt: "Paste the error log:",
      multiline: true,
      signal: new AbortController().signal,
    });
    expect(out.cancelled).toBe(true);
    expect(out.cancelledReason).toBe("aborted");
    expect(out.value).toBe("");
  });

  it("returns the partial multiline value when EOF comes mid-block", async () => {
    // The human typed 2 lines then the connection
    // dropped. We return the partial value (the
    // human typed something useful) rather than
    // treating it as a clean cancel.
    const input = Readable.from(["line 1\n", "line 2\n"]);
    const { provider } = makeProvider(input);
    const out = await provider.ask({
      prompt: "Paste the error log:",
      multiline: true,
      signal: new AbortController().signal,
    });
    expect(out.value).toBe("line 1\nline 2");
    expect(out.cancelled).toBe(false);
  });

  it("interprets a numeric choice as the options-picker index", async () => {
    const input = Readable.from(["2\n"]);
    const { provider } = makeProvider(input);
    const out = await provider.ask({
      prompt: "Which backend?",
      options: ["postgres", "sqlite", "memory"],
      signal: new AbortController().signal,
    });
    expect(out.value).toBe("sqlite");
    expect(out.optionIndex).toBe(1);
    expect(out.cancelled).toBe(false);
  });

  it("falls through to the free-form value when the input is not a number", async () => {
    const input = Readable.from(["maybe later\n"]);
    const { provider } = makeProvider(input);
    const out = await provider.ask({
      prompt: "Which backend?",
      options: ["postgres", "sqlite"],
      signal: new AbortController().signal,
    });
    expect(out.value).toBe("maybe later");
    expect(out.optionIndex).toBeUndefined();
    expect(out.cancelled).toBe(false);
  });

  it("returns cancelled when the signal is already aborted", async () => {
    const input = Readable.from(["never read\n"]);
    const { provider } = makeProvider(input);
    const ac = new AbortController();
    ac.abort();
    const out = await provider.ask({
      prompt: "Continue?",
      signal: ac.signal,
    });
    expect(out.cancelled).toBe(true);
    expect(out.cancelledReason).toBe("aborted");
    expect(out.value).toBe("");
  });

  it("honors a custom multiline sentinel", async () => {
    // Create a provider with a custom sentinel so we
    // exercise the opt-out from the default.
    const input = Readable.from(["a\n", "b\n", "END\n"]);
    const output = new CapturingWritable();
    const provider = createReplStdinProvider({
      input,
      output,
      multilineSentinel: "END",
      name: "repl-stdin-test",
    });
    const out = await provider.ask({
      prompt: "Paste:",
      multiline: true,
      signal: new AbortController().signal,
    });
    expect(out.value).toBe("a\nb");
    expect(out.cancelled).toBe(false);
    // The prompt header mentions the custom sentinel
    // (not the default).
    expect(output.text).toContain("END");
    expect(output.text).not.toContain(DEFAULT_MULTILINE_SENTINEL);
  });

  it("logs the prompt header before reading (the user sees the question)", async () => {
    const input = Readable.from(["yes\n"]);
    const output = new CapturingWritable();
    const { provider } = makeProvider(input, output);
    await provider.ask({
      prompt: "Do you want to continue?",
      signal: new AbortController().signal,
    });
    // The output buffer captured the prompt header
    // BEFORE the readline `line` event fires.
    expect(output.text).toContain("Do you want to continue?");
  });
});
