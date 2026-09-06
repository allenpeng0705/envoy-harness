import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { connectAcpWs, type WsJsonRpcClient } from "./acp/ws-jsonrpc.js";
import "./styles.css";

type Health = { ok: boolean; service?: string };

function App() {
  const [httpHealth, setHttpHealth] = useState<Health | null>(null);
  const [acpStatus, setAcpStatus] = useState<string>("connecting…");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [protocolVersion, setProtocolVersion] = useState<number | null>(null);

  useEffect(() => {
    let client: WsJsonRpcClient | undefined;
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch("/api/health");
        const body = (await res.json()) as Health;
        if (!cancelled) setHttpHealth(body);
      } catch (err) {
        if (!cancelled) {
          setHttpHealth({ ok: false });
          setAcpStatus(
            `HTTP health failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }

      try {
        client = await connectAcpWs();
        const init = (await client.request("initialize", {})) as {
          protocolVersion: number;
        };
        if (cancelled) return;
        setProtocolVersion(init.protocolVersion);
        const session = (await client.request("session/new", {
          cwd: undefined,
        })) as { sessionId: string };
        if (cancelled) return;
        setSessionId(session.sessionId);
        setAcpStatus("ready");
      } catch (err) {
        if (!cancelled) {
          setAcpStatus(
            `ACP failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      client?.close();
    };
  }, []);

  return (
    <div className="shell">
      <header className="hero">
        <p className="brand">envoy-harness</p>
        <h1>Standalone WebUI</h1>
        <p className="lede">
          Browser host over ACP WebSocket — Round 8 scaffold.
        </p>
      </header>
      <main className="panel">
        <h2>Health</h2>
        <dl>
          <dt>HTTP</dt>
          <dd>
            {httpHealth === null
              ? "…"
              : httpHealth.ok
                ? `ok (${httpHealth.service ?? "web"})`
                : "failed"}
          </dd>
          <dt>ACP</dt>
          <dd>{acpStatus}</dd>
          <dt>protocol</dt>
          <dd>{protocolVersion ?? "—"}</dd>
          <dt>session</dt>
          <dd className="mono">{sessionId ?? "—"}</dd>
        </dl>
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
