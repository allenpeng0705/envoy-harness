import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { EhuiShell } from "@envoymesh/envoy-harness-ehui";
import { AcpHost, type SessionSummary } from "./acp/host.js";
import { createBrowserEhuiDataSource } from "./acp/ehui-source.js";
import { ConnectionIndicator } from "./ConnectionIndicator.js";
import { MeshRail } from "./MeshRail.js";

function useAcpHost(host: AcpHost) {
  return useSyncExternalStore(
    (cb) => host.subscribe(cb),
    () => host.state,
    () => host.state,
  );
}

export function App() {
  const host = useMemo(() => new AcpHost(), []);
  const state = useAcpHost(host);
  const [draft, setDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [providerDraft, setProviderDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [questionDraft, setQuestionDraft] = useState("");
  const [ehuiRefresh, setEhuiRefresh] = useState(0);

  useEffect(() => {
    void host.connect().catch(() => undefined);
    return () => host.close();
  }, [host]);

  useEffect(() => {
    setProviderDraft(state.provider);
    setModelDraft(state.model);
  }, [state.provider, state.model]);

  useEffect(() => {
    if (!state.ready) return;
    void host.listSessions().then(setSessions).catch(() => setSessions([]));
  }, [host, state.ready, state.sessionId]);

  const ehuiSource = useMemo(() => {
    if (!state.sessionId || !state.ready) return null;
    return createBrowserEhuiDataSource(host, state.sessionId);
  }, [host, state.sessionId, state.ready]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || state.busy || !state.ready) return;
    setDraft("");
    await host.prompt(text);
    setEhuiRefresh((n) => n + 1);
  };

  const connectedLabel =
    state.connectionState === "connected"
      ? "live"
      : state.connectionState === "connecting"
        ? "connecting…"
        : state.connectionState === "disconnected"
          ? "offline"
          : "…";

  return (
    <div className="app">
      <header className="top">
        <div className="brand-block">
          <p className="brand">envoy-harness</p>
          <p className="tag">Primary WebUI</p>
        </div>
        <ConnectionIndicator
          state={state.connectionState}
          retryAttempt={state.retryAttempt}
          onReconnect={() => void host.reconnect()}
        />
        <div className="status-strip" aria-live="polite">
          <span className={`conn-${state.connectionState}`}>{connectedLabel}</span>
          <span className="sep">·</span>
          <span>
            {state.provider || "provider?"}
            {state.model ? ` / ${state.model}` : ""}
          </span>
          <span className="sep">·</span>
          <span title={state.cwd}>{state.cwd || "cwd"}</span>
          <span className="sep">·</span>
          <span>
            mesh {state.mesh?.connected ?? state.peerCount}/
            {state.mesh?.peerTotal ?? state.peerCount}
          </span>
          <span className="sep">·</span>
          <span className={state.busy ? "busy" : ""}>
            {state.busy ? "busy" : "idle"}
          </span>
          {state.sessionId ? (
            <>
              <span className="sep">·</span>
              <span className="mono" title={state.sessionId}>
                {state.sessionId.slice(0, 8)}
              </span>
            </>
          ) : null}
        </div>
        <div className="top-actions">
          <button type="button" onClick={() => setSettingsOpen((v) => !v)}>
            Settings
          </button>
          <button
            type="button"
            disabled={!state.busy}
            onClick={() => void host.cancel()}
          >
            Cancel
          </button>
        </div>
      </header>

      {state.connectionState === "disconnected" ? (
        <div className="banner warn" role="status">
          <span>
            Disconnected from ACP
            {state.error ? `: ${state.error}` : ""}. Auto-retry
            {state.retryAttempt > 0 ? ` #${state.retryAttempt}` : ""}…
          </span>
          <button type="button" onClick={() => void host.reconnect()}>
            Reconnect now
          </button>
        </div>
      ) : null}

      <div className="workspace">
        <section className="chat-pane">
          <div className="transcript" role="log">
            {state.messages.length === 0 ? (
              <p className="empty">
                {state.ready ? (
                  <>
                    Session <code>{state.sessionId}</code> ready. Local{" "}
                    <code>task</code> sub-agents run in parallel by default;
                    wire <code>--peers</code> for multi-node mesh.
                  </>
                ) : (
                  "Connecting to envoy-harness ACP…"
                )}
              </p>
            ) : (
              state.messages.map((m) => (
                <article key={m.id} className={`bubble ${m.role}`}>
                  <header>{m.role}</header>
                  <pre>{m.text}</pre>
                </article>
              ))
            )}
            {state.error && state.connectionState === "connected" ? (
              <p className="error">{state.error}</p>
            ) : null}
          </div>
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                state.ready
                  ? "Message the agent… (Enter to send, Shift+Enter newline)"
                  : "Waiting for connection…"
              }
              rows={3}
              disabled={!state.ready || state.busy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button
              type="submit"
              disabled={!state.ready || state.busy || !draft.trim()}
            >
              Send
            </button>
          </form>
        </section>

        <aside className="side">
          <MeshRail
            mesh={state.mesh}
            onRefresh={() => void host.refreshMesh()}
          />

          {settingsOpen ? (
            <div className="settings">
              <h2>Model & policy</h2>
              <label>
                Provider
                <input
                  value={providerDraft}
                  onChange={(e) => setProviderDraft(e.target.value)}
                  placeholder="openai / anthropic / …"
                />
              </label>
              <label>
                Model
                <input
                  value={modelDraft}
                  onChange={(e) => setModelDraft(e.target.value)}
                  placeholder="model id"
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  void host
                    .setModel(providerDraft.trim(), modelDraft.trim())
                    .catch(() => undefined)
                }
              >
                Apply model
              </button>
              <p className="hint">
                API keys stay in the Node bridge / env — not browser storage.
              </p>
              <label>
                Sandbox
                <select
                  value={state.sandbox}
                  onChange={(e) =>
                    void host
                      .setPolicy({ sandbox: e.target.value })
                      .catch(() => undefined)
                  }
                >
                  <option value="read-only">read-only</option>
                  <option value="workspace-write">workspace-write</option>
                  <option value="danger-full-access">danger-full-access</option>
                </select>
              </label>
              <label>
                Approval
                <select
                  value={state.approval}
                  onChange={(e) =>
                    void host
                      .setPolicy({ approval: e.target.value })
                      .catch(() => undefined)
                  }
                >
                  <option value="unless-trusted">unless-trusted</option>
                  <option value="on-request">on-request</option>
                  <option value="granular">granular</option>
                  <option value="never">never</option>
                </select>
              </label>
              <label>
                Auto-run
                <select
                  value={state.autoRun}
                  onChange={(e) =>
                    void host
                      .setPolicy({ autoRun: e.target.value })
                      .catch(() => undefined)
                  }
                >
                  <option value="always-confirm">always-confirm</option>
                  <option value="safe-only">safe-only</option>
                  <option value="off">off</option>
                </select>
              </label>
              <h2>Resume</h2>
              <ul className="session-list">
                {sessions.length === 0 ? (
                  <li className="muted">No persisted sessions</li>
                ) : (
                  sessions.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className="session-row"
                        onClick={() =>
                          void host.resumeSession(s.id).then(() => {
                            setEhuiRefresh((n) => n + 1);
                          })
                        }
                      >
                        <span className="mono">{s.id.slice(0, 8)}…</span>
                        <span>{s.title ?? "untitled"}</span>
                        <span className="muted">{s.messageCount} msgs</span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          ) : null}

          {ehuiSource ? (
            <div className="ehui-dock">
              <EhuiShell
                dataSource={ehuiSource}
                refreshKey={ehuiRefresh}
                onResumeSession={(id) => {
                  void host.resumeSession(id).then(() => {
                    setEhuiRefresh((n) => n + 1);
                    void host.listSessions().then(setSessions);
                  });
                }}
              />
            </div>
          ) : (
            <p className="muted side-placeholder">
              EHUI dock waits for a live session…
            </p>
          )}
        </aside>
      </div>

      {state.permission ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Permission</h2>
            <p>
              <strong>{state.permission.toolName}</strong>
            </p>
            <p>{state.permission.description}</p>
            <pre className="args">
              {JSON.stringify(state.permission.args, null, 2)}
            </pre>
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => state.permission?.resolve("deny")}
              >
                Deny
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => state.permission?.resolve("allow")}
              >
                Allow
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {state.userQuestion ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Question</h2>
            <p>{state.userQuestion.question}</p>
            {state.userQuestion.options?.length ? (
              <ul className="options">
                {state.userQuestion.options.map((opt, i) => (
                  <li key={opt}>
                    <button
                      type="button"
                      onClick={() =>
                        state.userQuestion?.resolve({
                          value: opt,
                          optionIndex: i,
                        })
                      }
                    >
                      {opt}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  state.userQuestion?.resolve({ value: questionDraft });
                  setQuestionDraft("");
                }}
              >
                <input
                  value={questionDraft}
                  onChange={(e) => setQuestionDraft(e.target.value)}
                  autoFocus
                />
                <button type="submit">Submit</button>
              </form>
            )}
            <button
              type="button"
              className="linkish"
              onClick={() =>
                state.userQuestion?.resolve({ value: "", cancelled: true })
              }
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
