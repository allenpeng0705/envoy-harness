/**
 * Phase E — Content-Length JSON-RPC framing.
 */

import type { JsonRpcMessage } from "./types.js";

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
    const bodyStart = sep + 4;
    if (this.#buf.byteLength < bodyStart + length) return undefined;
    const body = this.#buf.subarray(bodyStart, bodyStart + length);
    this.#buf = this.#buf.subarray(bodyStart + length);
    return JSON.parse(body.toString("utf8")) as JsonRpcMessage;
  }
}
