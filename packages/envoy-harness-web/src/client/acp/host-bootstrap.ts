/**
 * Session bootstrap for {@link AcpHost}: initialize, open the default
 * session, and read back the optional discovery subscription / config /
 * policy. Best-effort calls swallow their own errors — the only hard
 * requirement is `initialize` + `session/new`.
 */

import type { WsJsonRpcClient } from "./ws-jsonrpc.js";

export interface AcpBootstrap {
  sessionId: string;
  protocolVersion: number;
  provider: string;
  model: string;
  baseUrl: string;
  sandbox: string;
  approval: string;
  autoRun: string;
  cwd: string;
}

export async function bootstrapAcpSession(
  client: WsJsonRpcClient,
): Promise<AcpBootstrap> {
  const init = (await client.request("initialize", {})) as {
    protocolVersion: number;
  };
  const session = (await client.request("session/new", {})) as {
    sessionId: string;
  };

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
      sessionId: session.sessionId,
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

  return {
    sessionId: session.sessionId,
    protocolVersion: init.protocolVersion,
    provider: String(config["provider"] ?? ""),
    model: String(config["model"] ?? ""),
    baseUrl: String(config["baseUrl"] ?? ""),
    sandbox: policy.sandbox,
    approval: policy.approval,
    autoRun: policy.autoRun,
    cwd: String(config["cwd"] ?? ""),
  };
}
