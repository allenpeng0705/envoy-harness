/**
 * WebSocket ↔ `envoy-harness --acp` stdio JSON-RPC bridge.
 *
 * Browser speaks one JSON-RPC object per WebSocket text message.
 * The ACP child speaks **NDJSON** by default (`encodeNdjsonFrame`), and
 * still accepts Content-Length on stdin via AutoFrameDecoder. The bridge
 * therefore:
 * - writes NDJSON to the child (ACP standard)
 * - reads with AutoFrameDecoder (NDJSON or Content-Length)
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { WebSocket } from "ws";
import {
  AutoFrameDecoder,
  encodeNdjsonFrame,
} from "@envoymesh/envoy-harness";

export interface AcpWsBridgeOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  ws: WebSocket;
  onChildStderr?: (chunk: Buffer) => void;
  onChildExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface AcpWsBridge {
  child: ChildProcessWithoutNullStreams;
  close(): void;
}

export function attachAcpWsBridge(options: AcpWsBridgeOptions): AcpWsBridge {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const decoder = new AutoFrameDecoder();
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      options.ws.close();
    } catch {
      // ignore
    }
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };

  const flushToWs = (): void => {
    for (const msg of decoder.take()) {
      if (options.ws.readyState === options.ws.OPEN) {
        options.ws.send(JSON.stringify(msg));
      }
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    try {
      decoder.feed(chunk);
      flushToWs();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (options.ws.readyState === options.ws.OPEN) {
        options.ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: `frame decode: ${message}` },
          }),
        );
      }
      close();
    }
  });

  child.stdout.on("end", () => {
    try {
      for (const msg of decoder.flush()) {
        if (options.ws.readyState === options.ws.OPEN) {
          options.ws.send(JSON.stringify(msg));
        }
      }
    } catch {
      // ignore flush errors on teardown
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    options.onChildStderr?.(chunk);
  });

  child.on("exit", (code, signal) => {
    options.onChildExit?.(code, signal);
    close();
  });

  options.ws.on("message", (data) => {
    if (closed) return;
    try {
      const text =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Buffer.from(data as ArrayBuffer).toString("utf8");
      const msg = JSON.parse(text) as unknown;
      child.stdin.write(encodeNdjsonFrame(msg));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (options.ws.readyState === options.ws.OPEN) {
        options.ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: `invalid client message: ${message}` },
          }),
        );
      }
    }
  });

  options.ws.on("close", () => {
    close();
  });
  options.ws.on("error", () => {
    close();
  });

  return { child, close };
}
