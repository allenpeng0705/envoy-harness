/**
 * Browser-side JSON-RPC over WebSocket (one JSON object per message).
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export interface WsJsonRpcClientOptions {
  onClose?: (ev: CloseEvent) => void;
  onError?: () => void;
}

export class WsJsonRpcClient {
  readonly #ws: WebSocket;
  readonly #pending = new Map<JsonRpcId, Pending>();
  readonly #notificationHandlers = new Map<
    string,
    Set<(params: unknown) => void>
  >();
  #nextId = 1;
  #requestHandler:
    | ((method: string, params: unknown) => Promise<unknown>)
    | undefined;
  #closed = false;

  constructor(ws: WebSocket, options: WsJsonRpcClientOptions = {}) {
    this.#ws = ws;
    this.#ws.addEventListener("message", (ev) => {
      void this.#onMessage(String(ev.data));
    });
    this.#ws.addEventListener("close", (ev) => {
      this.#closed = true;
      for (const [, p] of this.#pending) {
        p.reject(new Error("WebSocket closed"));
      }
      this.#pending.clear();
      options.onClose?.(ev);
    });
    this.#ws.addEventListener("error", () => {
      options.onError?.();
    });
  }

  get closed(): boolean {
    return this.#closed || this.#ws.readyState === WebSocket.CLOSED;
  }

  onRequest(
    handler: (method: string, params: unknown) => Promise<unknown>,
  ): void {
    this.#requestHandler = handler;
  }

  onNotification(
    method: string,
    handler: (params: unknown) => void,
  ): () => void {
    let set = this.#notificationHandlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.#notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.#notificationHandlers.delete(method);
    };
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) throw new Error("WebSocket closed");
    const id = this.#nextId++;
    const msg: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return await new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#ws.send(JSON.stringify(msg));
      } catch (err) {
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async #onMessage(text: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof msg["method"] === "string" && msg["id"] !== undefined) {
      const method = msg["method"] as string;
      const id = msg["id"] as JsonRpcId;
      const params = msg["params"];
      try {
        const result =
          (await this.#requestHandler?.(method, params)) ??
          (() => {
            throw new Error(`unhandled server request: ${method}`);
          })();
        this.#ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
      } catch (err) {
        this.#ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: err instanceof Error ? err.message : String(err),
            },
          }),
        );
      }
      return;
    }

    if (typeof msg["method"] === "string" && msg["id"] === undefined) {
      const method = msg["method"] as string;
      const handlers = this.#notificationHandlers.get(method);
      if (handlers !== undefined) {
        for (const h of [...handlers]) h(msg["params"]);
      }
      return;
    }

    if (msg["id"] !== undefined && msg["id"] !== null) {
      const id = msg["id"] as JsonRpcId;
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      if (msg["error"] !== undefined) {
        const err = msg["error"] as { message?: string };
        pending.reject(new Error(err.message ?? "RPC error"));
      } else {
        pending.resolve(msg["result"]);
      }
    }
  }

  close(): void {
    if (!this.#closed && this.#ws.readyState < WebSocket.CLOSING) {
      this.#ws.close();
    }
  }
}

export function connectAcpWs(
  url = defaultAcpWsUrl(),
  options: WsJsonRpcClientOptions = {},
): Promise<WsJsonRpcClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      resolve(new WsJsonRpcClient(ws, options));
    });
    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      reject(new Error(`failed to connect ACP WebSocket at ${url}`));
    });
  });
}

export function defaultAcpWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/acp`;
}
