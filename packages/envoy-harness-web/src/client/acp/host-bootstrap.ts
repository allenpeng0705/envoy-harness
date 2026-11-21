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
  messages?: Array<{
    role?: string;
    text?: string;
    images?: Array<{ mimeType: string; data: string }>;
  }>;
  /** True when an existing session was loaded instead of `session/new`. */
  resumed: boolean;
}

export interface BootstrapOptions {
  /**
   * Prefer re-attaching this session after reconnect (DeepSeek-style
   * continuity). Falls back to the most recent `session/list` entry, then
   * `session/new`, when load fails.
   */
  preferSessionId?: string;
}

/** Survives browser restarts (sessionStorage does not). */
const LAST_SESSION_KEY = "eh-web-last-session-id";

export function readLastSessionId(): string | null {
  try {
    const v = localStorage.getItem(LAST_SESSION_KEY);
    if (v !== null && v.trim() !== "") return v.trim();
  } catch {
    // ignore
  }
  // Migrate from the older sessionStorage key once.
  try {
    const legacy = sessionStorage.getItem(LAST_SESSION_KEY);
    if (legacy !== null && legacy.trim() !== "") {
      writeLastSessionId(legacy.trim());
      sessionStorage.removeItem(LAST_SESSION_KEY);
      return legacy.trim();
    }
  } catch {
    // ignore
  }
  return null;
}

export function writeLastSessionId(id: string | null): void {
  try {
    if (id === null || id.trim() === "") {
      localStorage.removeItem(LAST_SESSION_KEY);
    } else {
      localStorage.setItem(LAST_SESSION_KEY, id.trim());
    }
  } catch {
    // ignore quota / private mode
  }
}

async function tryLoadSession(
  client: WsJsonRpcClient,
  sessionId: string,
): Promise<{
  sessionId: string;
  cwd?: string;
  messages?: Array<{ role?: string; text?: string; images?: Array<{ mimeType: string; data: string }> }>;
  resumed: true;
} | null> {
  try {
    const loaded = (await client.request("session/load", {
      sessionId,
    })) as {
      sessionId?: string;
      cwd?: string;
      messages?: Array<{ role?: string; text?: string; images?: Array<{ mimeType: string; data: string }> }>;
    };
    const id = loaded.sessionId ?? sessionId;
    return {
      sessionId: id,
      ...(typeof loaded.cwd === "string" && loaded.cwd.trim().length > 0
        ? { cwd: loaded.cwd.trim() }
        : {}),
      ...(loaded.messages !== undefined ? { messages: loaded.messages } : {}),
      resumed: true,
    };
  } catch {
    return null;
  }
}

/**
 * Pick the newest persisted session from `session/list`, if any.
 * Avoids spawning a fresh `--persist` session on every WebUI restart.
 */
async function mostRecentListedSession(
  client: WsJsonRpcClient,
): Promise<{ id: string; cwd?: string } | undefined> {
  try {
    const res = (await client.request("session/list", {})) as {
      sessions?: Array<{
        id?: string;
        sessionId?: string;
        cwd?: string;
        mtimeMs?: number;
      }>;
    };
    const list = Array.isArray(res.sessions) ? res.sessions : [];
    let best: { id: string; cwd?: string } | undefined;
    let bestMtime = -1;
    for (const s of list) {
      const id =
        typeof s.id === "string" && s.id.length > 0
          ? s.id
          : typeof s.sessionId === "string" && s.sessionId.length > 0
            ? s.sessionId
            : "";
      if (id === "") continue;
      const m =
        typeof s.mtimeMs === "number" && Number.isFinite(s.mtimeMs)
          ? s.mtimeMs
          : 0;
      if (m >= bestMtime) {
        bestMtime = m;
        best = {
          id,
          ...(typeof s.cwd === "string" && s.cwd.trim().length > 0
            ? { cwd: s.cwd.trim() }
            : {}),
        };
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

async function openSession(
  client: WsJsonRpcClient,
  preferSessionId: string | undefined,
): Promise<{
  sessionId: string;
  cwd?: string;
  messages?: Array<{ role?: string; text?: string; images?: Array<{ mimeType: string; data: string }> }>;
  resumed: boolean;
}> {
  if (preferSessionId !== undefined && preferSessionId.length > 0) {
    const loaded = await tryLoadSession(client, preferSessionId);
    if (loaded !== null) return loaded;
  }

  const recent = await mostRecentListedSession(client);
  if (recent !== undefined) {
    const loaded = await tryLoadSession(client, recent.id);
    if (loaded !== null) {
      return {
        ...loaded,
        // Prefer load echo; fall back to list metadata.
        ...(loaded.cwd === undefined && recent.cwd !== undefined
          ? { cwd: recent.cwd }
          : {}),
      };
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

  // Prefer the loaded session's cwd over config default (scratch). Otherwise
  // resume leaves the agent in a project while the UI thinks "No project".
  const configCwd = String(config["cwd"] ?? "");
  const cwd =
    opened.cwd !== undefined && opened.cwd.trim().length > 0
      ? opened.cwd.trim()
      : configCwd;

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
    cwd,
    ...(opened.messages !== undefined ? { messages: opened.messages } : {}),
    resumed: opened.resumed,
  };
}
