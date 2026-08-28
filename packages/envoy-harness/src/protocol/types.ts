/**
 * Phase E — JSON-RPC 2.0 types shared by ACP + SDK.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Session not found / busy / cancelled. */
  SESSION_ERROR: -32001,
  PERMISSION_DENIED: -32002,
} as const;

/** @deprecated Use {@link JsonRpcErrorCode.SESSION_ERROR}. */
export const SESSION_ERROR = JsonRpcErrorCode.SESSION_ERROR;

export class JsonRpcError extends Error {
  override readonly name = "JsonRpcError";
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return (
    "method" in msg &&
    "id" in msg &&
    (msg as JsonRpcRequest).id !== undefined &&
    !("result" in msg) &&
    !("error" in msg)
  );
}

export function isJsonRpcNotification(
  msg: JsonRpcMessage,
): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

export function isJsonRpcResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "result" in msg || "error" in msg;
}
