/**
 * Phase E — Content-Length JSON-RPC framing.
 */

import type { JsonRpcMessage } from "./types.js";

/**
 * Maximum frame body size in bytes. A malicious peer can claim
 * any `Content-Length`; without this cap a single line would
 * allocate the full buffer before parsing. 16 MB is generous
 * for a JSON-RPC request and well above any honest message
 * the harness produces.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(
    `Content-Length: ${body.byteLength}\r\n\r\n`,
    "utf8",
  );
  return Buffer.concat([header, body]);
}

/** Incremental Content-Length decoder. */
export class FrameDecoder {
  #buf = Buffer.alloc(0);
  /** Override the per-frame size cap (hermetic tests; do not
   *  raise this in production). Default: `MAX_FRAME_BYTES`. */
  readonly #maxBytes: number;

  constructor(options?: { maxBytes?: number }) {
    this.#maxBytes = options?.maxBytes ?? MAX_FRAME_BYTES;
  }

  feed(chunk: Buffer | string): void {
    const next = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.#buf = Buffer.concat([this.#buf, next]);
  }

  take(): JsonRpcMessage[] {
    const out: JsonRpcMessage[] = [];
    for (;;) {
      const msg = this.#tryTakeOne();
      if (msg === undefined) break;
      out.push(msg);
    }
    return out;
  }

  #tryTakeOne(): JsonRpcMessage | undefined {
    const sep = this.#buf.indexOf("\r\n\r\n");
    if (sep < 0) return undefined;
    const header = this.#buf.subarray(0, sep).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (match === null) {
      this.#buf = this.#buf.subarray(sep + 4);
      throw new Error(`missing Content-Length in header: ${header}`);
    }
    const length = Number(match[1]);
    // `(\d+)` only captures non-negative integers, so
    // `Number.isFinite` and `length < 0` are unreachable
    // here — the regex's "missing" branch handles
    // `Content-Length: -1` and `Content-Length: abc` before
    // we get to this point.
    if (length > this.#maxBytes) {
      throw new Error(
        `frame too large: ${length} bytes (max ${this.#maxBytes})`,
      );
    }
    const bodyStart = sep + 4;
    if (this.#buf.byteLength < bodyStart + length) return undefined;
    const body = this.#buf.subarray(bodyStart, bodyStart + length);
    this.#buf = this.#buf.subarray(bodyStart + length);
    return JSON.parse(body.toString("utf8")) as JsonRpcMessage;
  }
}

// ---------------------------------------------------------------------------
// Newline-delimited JSON (the ACP standard)
// ---------------------------------------------------------------------------

/**
 * Encode one message as newline-delimited JSON (**NDJSON**).
 *
 * **Why this exists alongside {@link encodeFrame}.** The Agent Client
 * Protocol — the dialect the ACP SDK implements and Zed et al. speak —
 * uses `JSON.stringify(message) + "\n"` with no header section
 * (`@agentclientprotocol/sdk`'s `ndJsonStream`). envoy shipped only the
 * LSP-style `Content-Length` framing, so a standard ACP client pointed
 * at `envoy-harness --acp` saw one JSON parse error per header line and
 * never completed `initialize` — the protocol was unusable with any
 * client but envoy's own.
 *
 * Content-Length remains available for envoy's internal client
 * dialect, and {@link AutoFrameDecoder} accepts either on input.
 */
export function encodeNdjsonFrame(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

/**
 * Incremental NDJSON decoder.
 *
 * Tolerant by construction, matching the ACP SDK's reader: blank lines
 * are skipped, a line is trimmed before parsing, and a malformed line is
 * dropped rather than killing the connection — on stdio the other end
 * may also be logging to the same pipe, and a single bad frame must not
 * take down a session.
 */
export class NdjsonFrameDecoder {
  #buf = "";
  readonly #onBadLine: ((line: string) => void) | undefined;

  constructor(options?: { onBadLine?: (line: string) => void }) {
    this.#onBadLine = options?.onBadLine;
  }

  feed(chunk: Buffer | string): void {
    this.#buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }

  take(): JsonRpcMessage[] {
    const out: JsonRpcMessage[] = [];
    for (;;) {
      const nl = this.#buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(JSON.parse(trimmed) as JsonRpcMessage);
      } catch {
        this.#onBadLine?.(trimmed);
      }
    }
    return out;
  }

  /** Flush a trailing unterminated line (peer closed mid-write). */
  flush(): JsonRpcMessage[] {
    const trimmed = this.#buf.trim();
    this.#buf = "";
    if (trimmed.length === 0) return [];
    try {
      return [JSON.parse(trimmed) as JsonRpcMessage];
    } catch {
      this.#onBadLine?.(trimmed);
      return [];
    }
  }
}

/** Which wire framing a connection uses. */
export type FrameDialect = "content-length" | "ndjson";

/**
 * A decoder that accepts EITHER framing, chosen by sniffing the first
 * bytes of the first chunk.
 *
 * **Why sniffing rather than a flag:** the difference is unambiguous —
 * a header-framed payload always begins with `Content-Length:` (or a
 * blank line before it), and a JSON-RPC message always begins with `{` —
 * so a host can serve both a standard ACP client and envoy's own client
 * from one server without configuration. Getting this wrong is silent
 * (both sides hang), so auto-detection is worth the few lines.
 */
export class AutoFrameDecoder {
  #impl: FrameDecoder | NdjsonFrameDecoder | undefined;
  #pending: Buffer = Buffer.alloc(0);
  readonly #onBadLine: ((line: string) => void) | undefined;

  constructor(options?: { onBadLine?: (line: string) => void }) {
    this.#onBadLine = options?.onBadLine;
  }

  /** The dialect chosen once enough bytes have arrived, if any. */
  get dialect(): FrameDialect | undefined {
    if (this.#impl instanceof FrameDecoder) return "content-length";
    if (this.#impl instanceof NdjsonFrameDecoder) return "ndjson";
    return undefined;
  }

  feed(chunk: Buffer | string): void {
    const next = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (this.#impl === undefined) {
      this.#pending = Buffer.concat([this.#pending, next]);
      this.#choose();
      return;
    }
    this.#impl.feed(next);
  }

  take(): JsonRpcMessage[] {
    if (this.#impl === undefined) return [];
    return this.#impl.take();
  }

  flush(): JsonRpcMessage[] {
    if (this.#impl instanceof NdjsonFrameDecoder) return this.#impl.flush();
    return [];
  }

  #choose(): void {
    // Skip leading CRLF/LF that a header-framed sender may emit first.
    const head = this.#pending.toString("utf8", 0, Math.min(64, this.#pending.length));
    if (head.length === 0) return;
    if (/^\s*Content-Length:/i.test(head)) {
      this.#impl = new FrameDecoder();
    } else if (head.trimStart().startsWith("{")) {
      this.#impl = new NdjsonFrameDecoder(
        this.#onBadLine !== undefined ? { onBadLine: this.#onBadLine } : {},
      );
    } else {
      // Not enough information yet (e.g. a partial "Content-Length").
      if (head.trim().length >= "Content-Length:".length) {
        this.#impl = new NdjsonFrameDecoder(
          this.#onBadLine !== undefined ? { onBadLine: this.#onBadLine } : {},
        );
      }
      if (this.#impl === undefined) return;
    }
    const buffered = this.#pending;
    this.#pending = Buffer.alloc(0);
    this.#impl.feed(buffered);
  }
}
