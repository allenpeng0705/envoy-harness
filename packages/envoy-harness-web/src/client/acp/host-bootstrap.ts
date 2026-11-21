/**
 * Session bootstrap for {@link AcpHost}: initialize, open the default
 * session, and read back the optional discovery subscription / config /
 * policy. Best-effort calls swallow their own errors — the only hard
 * requirement is `initialize` + a live session (`session/load` or
 * `session/new`).
 */

import type { WsJsonRpcClient } from "./ws-jsonrpc.js";

export interface AcpBootstrap {
  sessionId: string;
  protocolVersion: number;
  provider: string;
  model: string;
  baseUrl: string;
  decisionMode: string;
  decisionBackend: string;
  decisionEndpoint: string;
  sandbox: string;
  approval: string;
  autoRun: string;
  cwd: string;
  /** Hydrated transcript when resumed via `session/load`. */
  messages?: Array<{ role?: string; text?: string }>;
  /** True when an existing session was loaded instead of `session/new`. */
  resumed: boolean;
}

export interface BootstrapOptions {
  /**
   * Prefer re-attaching this session after reconnect (DeepSeek-style
   * continuity). Falls back to `session/new` when load fails.
   */
  preferSessionId?: string;
}

const LAST_SESSION_KEY = "eh-web-last-session-id";

export function readLastSessionId(): string | null {
  try {
    const v = sessionStorage.getItem(LAST_SESSION_KEY);
    return v !== null && v.trim() !== "" ? v.trim() : null;
  } catch {
    return null;
  }
}

export function writeLastSessionId(id: string | null): void {
  try {
    if (id === null || id.trim() === "") {
      sessionStorage.removeItem(LAST_SESSION_KEY);
    } else {
      sessionStorage.setItem(LAST_SESSION_KEY, id);
    }
  } catch {
    // ignore quota / private mode
  }
}

async function openSession(
  client: WsJsonRpcClient,
  preferSessionId: string | undefined,
): Promise<{
  sessionId: string;
  messages?: Array<{ role?: string; text?: string }>;
  resumed: boolean;
}> {
  if (preferSessionId !== undefined && preferSessionId.length > 0) {
    try {
      const loaded = (await client.request("session/load", {
        sessionId: preferSessionId,
      })) as {
        sessionId?: string;
        messages?: Array<{ role?: string; text?: string }>;
      };
      const id = loaded.sessionId ?? preferSessionId;
      return {
        sessionId: id,
        ...(loaded.messages !== undefined ? { messages: loaded.messages } : {}),
        resumed: true,
      };
    } catch {
      // fall through to session/new
    }
  }
  const session = (await client.request("session/new", {})) as {
    sessionId: string;
  };
  return { sessionId: session.sessionId, resumed: false };
}

export async function bootstrapAcpSession(
  client: WsJsonRpcClient,
  options: BootstrapOptions = {},
): Promise<AcpBootstrap> {
  const init = (await client.request("initialize", {})) as {
    protocolVersion: number;
  };
  const prefer =
    options.preferSessionId?.trim() || readLastSessionId() || undefined;
  const opened = await openSession(client, prefer);

  // Best-effort discovery subscription (Trace panel + mesh rail).
  try {
    await client.request("discovery/subscribe", {});
  } catch {
    // host may not support discovery
  }

  let config: Record<string, unknown> = {};
  try {
    config = (await client.request("config/get", {})) as Record<
      string,
      unknown
    >;
  } catch {
    // optional
  }

  let policy = {
    sandbox: "read-only",
    approval: "on-request",
    autoRun: "always-confirm",
  };
  try {
    const res = (await client.request("session/get_policy", {
      sessionId: opened.sessionId,
    })) as {
      result?: { sandbox?: string; approval?: string; autoRun?: string };
    };
    policy = {
      sandbox: res.result?.sandbox ?? policy.sandbox,
      approval: res.result?.approval ?? policy.approval,
      autoRun: res.result?.autoRun ?? policy.autoRun,
    };
  } catch {
    // optional
  }

  const decision =
    config["decision"] !== null && typeof config["decision"] === "object"
      ? (config["decision"] as Record<string, unknown>)
      : {};

  writeLastSessionId(opened.sessionId);

  return {
    sessionId: opened.sessionId,
    protocolVersion: init.protocolVersion,
    provider: String(config["provider"] ?? ""),
    model: String(config["model"] ?? ""),
    baseUrl: String(config["baseUrl"] ?? ""),
    decisionMode: String(decision["mode"] ?? "off"),
    decisionBackend: String(decision["backend"] ?? "null"),
    decisionEndpoint: String(decision["endpoint"] ?? ""),
    sandbox: policy.sandbox,
    approval: policy.approval,
    autoRun: policy.autoRun,
    cwd: String(config["cwd"] ?? ""),
    ...(opened.messages !== undefined ? { messages: opened.messages } : {}),
    resumed: opened.resumed,
  };
}
