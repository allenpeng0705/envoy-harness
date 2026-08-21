/**
 * Shared test helpers — the REPL, CLI, and sub-agent
 * tests all need the same building blocks (a writable
 * that records, a scripted model, a fake line reader,
 * a default RunParsedArgs, a content-block helper).
 *
 * T2.1 consolidated these from ~13 test files. The
 * canonical shapes here are:
 *
 * - `StringWritable` — `Writable` stream that records
 *   everything written; `out.data` is the accumulated
 *   text. Use one per output stream (stdout / stderr).
 * - `scriptedModel(responses)` — `ModelAdapter` that
 *   returns the next response on each call. The
 *   `responses` array is `{ content, stopReason? }[]`
 *   where `content` is `ModelResponse["content"]`
 *   (i.e., `ContentBlock[]`). Throws on exhaustion
 *   so tests declare their expected call count.
 *   Returns `{ callCount: () => number }` for
 *   "how many times did the model get called".
 * - `scriptedTextModel(text)` — convenience wrapper
 *   for the common "the model just says this one
 *   thing" case. Equivalent to
 *   `scriptedModel([{ content: [textBlock(text)] }])`.
 * - `textBlock(text)` — `ModelResponse["content"][number]`
 *   helper for a single text content block.
 * - `fakeLineReader(lines)` — `LineReader` that yields
 *   predetermined lines, then ends. Mirrors the
 *   `LineReader` contract: `next()` returns
 *   `{ value, done: false }` then `{ done: true }`;
 *   `close()` is a no-op for the fake.
 * - `makeArgs(overrides, options?)` — minimal valid
 *   `RunParsedArgs` for tests. `options.repl`
 *   defaults to `false` (so `parseArgs([])` and
 *   `runRepl({...})` both work without surprises);
 *   set `options.repl: true` for tests that need the
 *   REPL flag.
 *
 * The pattern: tests import the helpers they use, and
 * drop their own local copies. Adding a new helper here
 * is fine if the same shape appears in 2+ test files.
 */

import { Writable } from "node:stream";

import type {
  LineReader,
  ModelAdapter,
  ModelResponse,
  RunParsedArgs,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Stream recorders
// ---------------------------------------------------------------------------

/**
 * A `Writable` that records everything written to it.
 *
 * Use one per output stream (stdout / stderr). After the
 * operation, read `out.data` to assert what was written.
 *
 * ```ts
 * const out = new StringWritable();
 * await run({ args: makeArgs(), model, stdout: out, stderr: new StringWritable() });
 * expect(out.data).toContain("expected output");
 * ```
 */
export class StringWritable extends Writable {
  data = "";

  override _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (error?: Error | null) => void,
  ): void {
    this.data += chunk.toString();
    cb();
  }
}

// ---------------------------------------------------------------------------
// Scripted model
// ---------------------------------------------------------------------------

/**
 * A scripted `ModelAdapter`: each `complete()` call returns
 * the next response in `responses`. Throws on exhaustion
 * so tests declare their expected call count (this is
 * better than a silent "last response on every extra
 * call" because it surfaces off-by-one mistakes).
 *
 * Use `textBlock(s)` to build simple text content. For
 * tool calls, pass `{ type: "tool_call", name, args, id }`
 * blocks directly.
 *
 * ```ts
 * const model = scriptedModel([
 *   { content: [textBlock("first reply")] },
 *   { content: [textBlock("second reply")] },
 * ]);
 * await runRepl({ model, args: makeArgs(), lineReader: ..., stdout: ..., stderr: ... });
 * expect(model.callCount()).toBe(2);
 * ```
 */
export function scriptedModel(
  responses: ReadonlyArray<{
    content: ModelResponse["content"];
    stopReason?: ModelResponse["stopReason"];
  }>,
): ModelAdapter & { callCount: () => number } {
  let i = 0;
  return {
    async complete() {
      const r = responses[i++];
      if (!r) {
        throw new Error(
          `scriptedModel: exhausted (called ${i} times, only ${responses.length} responses)`,
        );
      }
      return {
        content: r.content,
        stopReason:
          r.stopReason ??
          (r.content.some((b) => b.type === "tool_call")
            ? "tool_use"
            : "end_turn"),
      };
    },
    callCount: () => i,
  };
}

/**
 * Convenience: a model that always returns the same single
 * text response. Equivalent to
 * `scriptedModel([{ content: [textBlock(text)] }])`.
 *
 * Use when the test doesn't care about call count, only
 * about the model "saying something". For tool-call tests,
 * use `scriptedModel` directly.
 */
export function scriptedTextModel(text: string): ModelAdapter {
  return scriptedModel([{ content: [textBlock(text)] }]);
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

/**
 * Helper: a single `text` content block.
 *
 * Use inside `scriptedModel([...])` to build responses.
 * Equivalent to `{ type: "text", text } as const` but
 * keeps the call sites scannable.
 */
export function textBlock(
  text: string,
): ModelResponse["content"][number] {
  return { type: "text", text };
}

// ---------------------------------------------------------------------------
// Fake line reader
// ---------------------------------------------------------------------------

/**
 * A fake `LineReader` that yields predetermined lines, then ends.
 *
 * Mirrors the `LineReader` contract: `next()` returns
 * `{ value, done: false }` for each line, then
 * `{ done: true }` on EOF. `close()` is a no-op for the fake
 * (no real stream to release). Suitable for `RunOptions.lineReader?`
 * injection in CLI tests and for `ReplOptions.lineReader?` in
 * REPL tests.
 */
export function fakeLineReader(lines: ReadonlyArray<string>): LineReader {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<string>> {
      if (i >= lines.length) {
        return { value: undefined as unknown as string, done: true };
      }
      const value = lines[i++];
      if (value === undefined) {
        return { value: undefined as unknown as string, done: true };
      }
      return { value, done: false };
    },
    close() {
      // no-op for the fake
    },
  };
}

// ---------------------------------------------------------------------------
// Default RunParsedArgs
// ---------------------------------------------------------------------------

/**
 * A minimal valid `RunParsedArgs` for tests.
 *
 * `options.repl` defaults to `false` (matches the
 * one-shot `run` flow). Set `options.repl: true` for
 * tests that need the REPL flag set so the CLI
 * accepts the line reader + the REPL loop runs.
 *
 * Anything in `overrides` is shallow-merged on top.
 * The shape is the full `RunParsedArgs` so tests that
 * need a specific subcommand, a `cwd`, a `provider`,
 * etc., can pass them through.
 */
export function makeArgs(
  overrides: Partial<RunParsedArgs> = {},
  options: { repl?: boolean } = {},
): RunParsedArgs {
  return {
    subcommand: "run",
    help: false,
    version: false,
    json: false,
    sandbox: undefined,
    approval: undefined,
    model: undefined,
    provider: undefined,
    cwd: undefined,
    maxTurns: undefined,
    maxCostUsd: undefined,
    resume: undefined,
    resumeRemote: undefined,
    fork: undefined,
    plugins: [],
    pluginConfigs: [],
    persist: false,
    sessionDir: undefined,
    plan: false,
    repl: options.repl ?? false,
    acp: false,
    noColor: false,
    verbose: false,
    quiet: false,
    positional: [],
    ...overrides,
  };
}
