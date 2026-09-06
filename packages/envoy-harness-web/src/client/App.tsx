import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from "react";
import { AcpHost, type SessionSummary } from "./acp/host.js";
import { createBrowserEhuiDataSource } from "./acp/ehui-source.js";
import { DetailsRail } from "./DetailsRail.js";
import { EmptyHero } from "./EmptyHero.js";
import { PermissionModal } from "./PermissionModal.js";
import { SessionRail } from "./SessionRail.js";
import { SettingsModal, type ThemeMode } from "./SettingsModal.js";
import { Transcript } from "./Transcript.js";

function useAcpHost(host: AcpHost) {
  return useSyncExternalStore(
    (cb) => host.subscribe(cb),
    () => host.state,
    () => host.state,
  );
}

function readTheme(): ThemeMode {
  try {
    const v = localStorage.getItem("eh-web-theme");
    return v === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function readWidth(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n >= 160 ? n : fallback;
  } catch {
    return fallback;
  }
}

export function App(): JSX.Element {
  const host = useMemo(() => new AcpHost(), []);
  const state = useAcpHost(host);
  const [draft, setDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [providerDraft, setProviderDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [questionDraft, setQuestionDraft] = useState("");
  const [ehuiRefresh, setEhuiRefresh] = useState(0);
  const [theme, setTheme] = useState<ThemeMode>(readTheme);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  const [queueLen, setQueueLen] = useState(0);
  const [sidebarW, setSidebarW] = useState(() =>
    readWidth("eh-web-sidebar-w", 260),
  );
  const [detailsW, setDetailsW] = useState(() =>
    readWidth("eh-web-details-w", 340),
  );
  const dragRef = useRef<"sidebar" | "details" | null>(null);
  const sidebarWRef = useRef(sidebarW);
  const detailsWRef = useRef(detailsW);
  const promptQueueRef = useRef<string[]>([]);
  const drainingRef = useRef(false);
  sidebarWRef.current = sidebarW;
  detailsWRef.current = detailsW;

  useEffect(() => {
    void host.connect().catch(() => undefined);
    return () => host.close();
  }, [host]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("eh-web-theme", theme);
    } catch {
      // ignore
    }
  }, [theme]);

  useEffect(() => {
    setProviderDraft(state.provider);
    setModelDraft(state.model);
  }, [state.provider, state.model]);

  const refreshSessions = useCallback(() => {
    if (!state.ready) return;
    void host.listSessions().then(setSessions).catch(() => setSessions([]));
  }, [host, state.ready]);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions, state.sessionId]);

  const ehuiSource = useMemo(() => {
    if (!state.sessionId || !state.ready) return null;
    return createBrowserEhuiDataSource(host, state.sessionId);
  }, [host, state.sessionId, state.ready]);

  const runPrompt = useCallback(
    async (text: string): Promise<void> => {
      await host.prompt(text);
      setEhuiRefresh((n) => n + 1);
      refreshSessions();
    },
    [host, refreshSessions],
  );

  /** Send now, or queue behind the active turn. */
  const enqueueOrSend = useCallback((): void => {
    const text = draft.trim();
    if (!text || !state.ready || state.permission) return;
    if (state.busy || drainingRef.current) {
      promptQueueRef.current.push(text);
      setQueueLen(promptQueueRef.current.length);
      setDraft("");
      return;
    }
    setDraft("");
    void runPrompt(text);
  }, [draft, state.ready, state.busy, state.permission, runPrompt]);

  // Drain one queued prompt when the agent becomes idle.
  useEffect(() => {
    if (
      state.busy ||
      !state.ready ||
      state.permission ||
      promptQueueRef.current.length === 0 ||
      drainingRef.current
    ) {
      return;
    }
    const next = promptQueueRef.current.shift()!;
    setQueueLen(promptQueueRef.current.length);
    drainingRef.current = true;
    void runPrompt(next).finally(() => {
      drainingRef.current = false;
      // Re-trigger drain if more were queued while we ran.
      setQueueLen(promptQueueRef.current.length);
    });
  }, [state.busy, state.ready, state.permission, queueLen, runPrompt]);

  const onResume = (id: string): void => {
    promptQueueRef.current = [];
    setQueueLen(0);
    void host.resumeSession(id).then(() => {
      setEhuiRefresh((n) => n + 1);
      refreshSessions();
    });
  };

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      if (dragRef.current === "sidebar") {
        const w = Math.min(420, Math.max(180, e.clientX));
        setSidebarW(w);
      } else if (dragRef.current === "details") {
        const w = Math.min(520, Math.max(240, window.innerWidth - e.clientX));
        setDetailsW(w);
      }
    };
    const onUp = (): void => {
      if (dragRef.current === "sidebar") {
        try {
          localStorage.setItem(
            "eh-web-sidebar-w",
            String(sidebarWRef.current),
          );
        } catch {
          // ignore
        }
      }
      if (dragRef.current === "details") {
        try {
          localStorage.setItem(
            "eh-web-details-w",
            String(detailsWRef.current),
          );
        } catch {
          // ignore
        }
      }
      dragRef.current = null;
      document.body.classList.remove("col-dragging");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const gridStyle = {
    gridTemplateColumns: [
      sidebarCollapsed ? "56px" : `${sidebarW}px`,
      "8px",
      "minmax(0, 1fr)",
      "8px",
      detailsCollapsed ? "56px" : `${detailsW}px`,
    ].join(" "),
  };

  return (
    <div className="app">
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

      <div className="workspace" style={gridStyle}>
        <SessionRail
          connectionState={state.connectionState}
          retryAttempt={state.retryAttempt}
          onReconnect={() => void host.reconnect()}
          sessions={sessions}
          activeSessionId={state.sessionId}
          onNewSession={() => {
            promptQueueRef.current = [];
            setQueueLen(0);
            void host.newSession().then(() => {
              setEhuiRefresh((n) => n + 1);
              refreshSessions();
            });
          }}
          onResume={onResume}
          onOpenSettings={() => setSettingsOpen(true)}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
          provider={state.provider}
          model={state.model}
        />

        <div
          className="col-handle"
          data-side="sidebar"
          onPointerDown={() => {
            if (sidebarCollapsed) return;
            dragRef.current = "sidebar";
            document.body.classList.add("col-dragging");
          }}
        />

        <section className="chat-pane">
          <header className="chat-top">
            <div className="chat-status" aria-live="polite">
              <span className={`conn-${state.connectionState}`}>
                {state.connectionState === "connected"
                  ? "live"
                  : state.connectionState === "connecting"
                    ? "connecting…"
                    : "offline"}
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
              {queueLen > 0 ? (
                <>
                  <span className="sep">·</span>
                  <span className="busy">{queueLen} queued</span>
                </>
              ) : null}
            </div>
            <button
              type="button"
              disabled={!state.busy}
              onClick={() => void host.cancel()}
            >
              Stop
            </button>
          </header>

          <Transcript
            messages={state.messages}
            busy={state.busy}
            error={state.error}
            showConnectionError={state.connectionState === "connected"}
            empty={
              <EmptyHero
                ready={state.ready}
                sessionId={state.sessionId}
                cwd={state.cwd}
              />
            }
          />

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              enqueueOrSend();
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                state.ready
                  ? state.busy
                    ? "Agent is working… Enter queues the next message"
                    : "Message the agent… (Enter to send, Shift+Enter newline)"
                  : "Waiting for connection…"
              }
              rows={3}
              disabled={!state.ready || Boolean(state.permission)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  enqueueOrSend();
                }
              }}
            />
            {state.busy ? (
              <div className="composer-actions">
                {draft.trim() ? (
                  <button
                    type="button"
                    onClick={() => enqueueOrSend()}
                    disabled={!state.ready}
                  >
                    Queue
                  </button>
                ) : null}
                <button
                  type="button"
                  className="primary stop"
                  onClick={() => void host.cancel()}
                >
                  Stop
                </button>
              </div>
            ) : (
              <button
                type="submit"
                className="primary"
                disabled={!state.ready || !draft.trim()}
              >
                Send
              </button>
            )}
          </form>
        </section>

        <div
          className="col-handle"
          data-side="details"
          onPointerDown={() => {
            if (detailsCollapsed) return;
            dragRef.current = "details";
            document.body.classList.add("col-dragging");
          }}
        />

        <DetailsRail
          mesh={state.mesh}
          onRefreshMesh={() => void host.refreshMesh()}
          ehuiSource={ehuiSource}
          ehuiRefresh={ehuiRefresh}
          onResumeSession={(id) => {
            onResume(id);
          }}
          collapsed={detailsCollapsed}
          onToggleCollapsed={() => setDetailsCollapsed((v) => !v)}
        />
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        providerDraft={providerDraft}
        modelDraft={modelDraft}
        onProviderDraft={setProviderDraft}
        onModelDraft={setModelDraft}
        onApplyModel={() =>
          void host
            .setModel(providerDraft.trim(), modelDraft.trim())
            .catch(() => undefined)
        }
        sandbox={state.sandbox}
        approval={state.approval}
        autoRun={state.autoRun}
        onPolicy={(partial) =>
          void host.setPolicy(partial).catch(() => undefined)
        }
        theme={theme}
        onTheme={setTheme}
      />

      <PermissionModal
        permission={state.permission}
        userQuestion={state.userQuestion}
        questionDraft={questionDraft}
        onQuestionDraft={setQuestionDraft}
      />
    </div>
  );
}
