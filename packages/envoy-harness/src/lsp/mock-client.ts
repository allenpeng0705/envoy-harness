/**
 * MockLspClient — a scriptable `LspClient` for tests.
 *
 * **Why this exists:** the 4 LSP tools need an `LspClient`
 * to test against, but `StdioLspClient` requires a real
 * language server (slow, flaky, hard to script). `MockLspClient`
 * accepts pre-configured response tables and an optional
 * per-call recorder so tests can assert on what the tools
 * asked for.
 *
 * **Three response tables, one per op:**
 * - `definitions` — keyed by `${file}:${line}:${column}`.
 * - `references` — same key.
 * - `hovers` — same key, value is `LspHover | null`.
 * - `diagnostics` — keyed by file (no position; diagnostics
 *   cover a range).
 *
 * Unmatched keys → empty array / null (silent no-op).
 *
 * **`calls` recorder:** every method call appends a record
 * `{ op, file, line, column }` so tests can assert on
 * "the tool called hover with these args". `calls` is
 * append-only; clear with `clearCalls()`.
 *
 * **Stability:** the public surface is `MockLspClient`
 * (class) + `MockLspResponseTable` (type). Additive.
 */

import type {
  LspClient,
  LspDiagnostic,
  LspHover,
  LspLocation,
} from "./types.js";

/** The position key for `definition` / `references` / `hover`. */
type PosKey = string;

const posKey = (file: string, line: number, column: number): PosKey =>
  `${file}:${line}:${column}`;

/** A recorded call: which op, with which args. */
export interface MockLspCall {
  op: "definition" | "references" | "hover" | "diagnostics";
  file: string;
  line?: number;
  column?: number;
}

/** Response tables: keyed by file/position. */
export interface MockLspResponseTable {
  /** Keyed by `${file}:${line}:${column}` → locations. */
  definitions?: Map<PosKey, ReadonlyArray<LspLocation>>;
  /** Keyed by `${file}:${line}:${column}` → locations. */
  references?: Map<PosKey, ReadonlyArray<LspLocation>>;
  /** Keyed by `${file}:${line}:${column}` → hover (or null). */
  hovers?: Map<PosKey, LspHover | null>;
  /** Keyed by `file` → diagnostics. */
  diagnostics?: Map<string, ReadonlyArray<LspDiagnostic>>;
}

/**
 * A scriptable `LspClient`. Construct with a response table;
 * call any method; the response table is consulted by key.
 */
export class MockLspClient implements LspClient {
  private readonly responses: Required<MockLspResponseTable>;
  private readonly _calls: MockLspCall[] = [];
  private _closed = false;

  constructor(responses: MockLspResponseTable = {}) {
    this.responses = {
      definitions: responses.definitions ?? new Map(),
      references: responses.references ?? new Map(),
      hovers: responses.hovers ?? new Map(),
      diagnostics: responses.diagnostics ?? new Map(),
    };
  }

  async definition(
    file: string,
    line: number,
    column: number,
  ): Promise<ReadonlyArray<LspLocation>> {
    this.assertOpen();
    this._calls.push({ op: "definition", file, line, column });
    return this.responses.definitions.get(posKey(file, line, column)) ?? [];
  }

  async references(
    file: string,
    line: number,
    column: number,
  ): Promise<ReadonlyArray<LspLocation>> {
    this.assertOpen();
    this._calls.push({ op: "references", file, line, column });
    return this.responses.references.get(posKey(file, line, column)) ?? [];
  }

  async hover(
    file: string,
    line: number,
    column: number,
  ): Promise<LspHover | null> {
    this.assertOpen();
    this._calls.push({ op: "hover", file, line, column });
    return this.responses.hovers.get(posKey(file, line, column)) ?? null;
  }

  async diagnostics(file: string): Promise<ReadonlyArray<LspDiagnostic>> {
    this.assertOpen();
    this._calls.push({ op: "diagnostics", file });
    return this.responses.diagnostics.get(file) ?? [];
  }

  async close(): Promise<void> {
    this._closed = true;
  }

  // --- test helpers ---

  /** All recorded calls. Append-only. */
  get calls(): ReadonlyArray<MockLspCall> {
    return this._calls;
  }

  /** Clear the calls list. Useful when re-using a client. */
  clearCalls(): void {
    this._calls.length = 0;
  }

  private assertOpen(): void {
    if (this._closed) {
      throw new Error("MockLspClient: method called after close()");
    }
  }
}
