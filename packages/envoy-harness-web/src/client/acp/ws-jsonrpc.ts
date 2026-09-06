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

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

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

  constructor(ws: WebSocket) {
    this.#ws = ws;
    this.#ws.addEventListener("message", (ev) => {
      void this.#onMessage(String(ev.data));
    });
    this.#ws.addEventListener("close", () => {
      for (const [, p] of this.#pending) {
        p.reject(new Error("WebSocket closed"));
      }
      this.#pending.clear();
    });
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
    const id = this.#nextId++;
    const msg: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return await new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify(msg));
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
      // Server → client request (permissions / user questions).
      const method = msg["method"] as string;
      const id = msg["id"] as JsonRpcId;
      const params = msg["params"];
      try {
        const result =
          (await this.#requestHandler?.(method, params)) ??
          (() => {
            throw new Error(`unhandled server request: ${method}`);
          })();
        this.#ws.send(
          JSON.stringify({ jsonrpc: "2.0", id, result }),
        );
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
    this.#ws.close();
  }
}

export function connectAcpWs(url = defaultAcpWsUrl()): Promise<WsJsonRpcClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(new WsJsonRpcClient(ws)));
    ws.addEventListener("error", () =>
      reject(new Error(`failed to connect ACP WebSocket at ${url}`)),
    );
  });
}

export function defaultAcpWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/acp`;
}
