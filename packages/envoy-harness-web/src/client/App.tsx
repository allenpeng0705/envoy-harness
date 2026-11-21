import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from "react";
import { AcpHost, type SessionSummary, type WorkspaceEntry } from "./acp/host.js";
import { createBrowserEhuiDataSource } from "./acp/ehui-source.js";
import { AskUserModal } from "./AskUserModal.js";
import { ChangesDock } from "./ChangesDock.js";
import { ChatSplit } from "./ChatSplit.js";
import { Composer } from "./Composer.js";
import { ContextChrome } from "./ContextChrome.js";
import { ContextStrip } from "./ContextStrip.js";
import {
  DetailsRail,
  type DetailsFocusRequest,
} from "./DetailsRail.js";
import { EmptyHero } from "./EmptyHero.js";
import { PermissionDock } from "./PermissionDock.js";
import { ProjectPickerModal } from "./ProjectPickerModal.js";
import { QueuePanel, type QueuedPrompt } from "./QueuePanel.js";
import { SessionRail } from "./SessionRail.js";
import { SessionTabsBar } from "./SessionTabsBar.js";
import { SettingsModal, type ThemeMode } from "./SettingsModal.js";
import { TurnHintsDock } from "./TurnHintsDock.js";
import { isPrimaryMod, shortPathLabel } from "./path-display.js";
import {
  activateLeafTab,
  bindFocusedPaneSession,
  closeLeafTab,
  collapseToFocused,
  findLeaf,
  focusedLeaf,
  focusedPaneSessionId,
  isSplitLayout,
  leafCount,
  listLeaves,
  pickSplitPartner,
  prunePaneSessions,
  readSessionPanes,
  sessionOpenInAnyLeaf,
  setPaneFocus,
  setSplitRatio,
  splitFocusedLeaf,
  unsplitFocused,
  writeSessionPanes,
  type SessionPanesState,
  type SplitDirection,
} from "./session-panes.js";
import {
  closeSessionTab,
  openSessionTab,
  pruneSessionTabs,
  readSessionTabs,
  setActiveSessionTab,
  writeSessionTabs,
  type SessionTabsState,
} from "./session-tabs.js";
import {
  readEnterBehavior,
  readFontSizePx,
  writeEnterBehavior,
  writeFontSizePx,
  type EnterBehavior,
} from "./slash-catalog.js";
import {
  readArchivedSessionIds,
  readPinnedSessionIds,
  writeArchivedSessionIds,
  writePinnedSessionIds,
} from "./session-groups.js";
import {
  attachmentFootnote,
  buildPromptPayload,
  type DraftAttachment,
} from "./attachments.js";

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
    if (v === "dark" || v === "light" || v === "system") return v;
    return "system";
  } catch {
    return "system";
  }
}

function resolveTheme(theme: ThemeMode): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
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
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [providerDraft, setProviderDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [decisionEndpointDraft, setDecisionEndpointDraft] = useState("");
  const [questionDraft, setQuestionDraft] = useState("");
  const [ehuiRefresh, setEhuiRefresh] = useState(0);
  const [theme, setTheme] = useState<ThemeMode>(readTheme);
  const [enterBehavior, setEnterBehavior] = useState<EnterBehavior>(
    readEnterBehavior,
  );
  const [fontSizePx, setFontSizePx] = useState(readFontSizePx);
  const [pinnedIds, setPinnedIds] = useState(() => readPinnedSessionIds());
  const [archivedIds, setArchivedIds] = useState(() =>
    readArchivedSessionIds(),
  );
  const [sessionTabs, setSessionTabs] = useState<SessionTabsState>(() =>
    readSessionTabs(),
  );
  const [sessionPanes, setSessionPanes] = useState<SessionPanesState>(() =>
    readSessionPanes(),
  );
  /** Per-tab composer draft / attachments / queue (DSH-style). */
  const tabDraftsRef = useRef<
    Map<
      string,
      {
        draft: string;
        attachments: DraftAttachment[];
        queue: QueuedPrompt[];
      }
    >
  >(new Map());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  const [promptQueue, setPromptQueue] = useState<QueuedPrompt[]>([]);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [detailsFocus, setDetailsFocus] = useState<DetailsFocusRequest | null>(
    null,
  );
  const detailsFocusSeq = useRef(0);
  const [sidebarW, setSidebarW] = useState(() =>
    readWidth("eh-web-sidebar-w", 260),
  );
  const [detailsW, setDetailsW] = useState(() =>
    readWidth("eh-web-details-w", 340),
  );
  const dragRef = useRef<"sidebar" | "details" | null>(null);
  const sidebarWRef = useRef(sidebarW);
  const detailsWRef = useRef(detailsW);
  const drainingRef = useRef(false);
  /** After a failed queue drain, stop auto-retry until the user acts. */
  const drainHaltRef = useRef(false);
  sidebarWRef.current = sidebarW;
  detailsWRef.current = detailsW;

  useEffect(() => {
    void host.connect().catch(() => undefined);
    return () => host.close();
  }, [host]);

  useEffect(() => {
    const apply = (): void => {
      document.documentElement.dataset.theme = resolveTheme(theme);
    };
    apply();
    try {
      localStorage.setItem("eh-web-theme", theme);
    } catch {
      // ignore
    }
    if (theme !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => apply();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--eh-font-size",
      `${fontSizePx}px`,
    );
    writeFontSizePx(fontSizePx);
  }, [fontSizePx]);

  useEffect(() => {
    writeEnterBehavior(enterBehavior);
  }, [enterBehavior]);

  useEffect(() => {
    writePinnedSessionIds(pinnedIds);
  }, [pinnedIds]);

  useEffect(() => {
    writeArchivedSessionIds(archivedIds);
  }, [archivedIds]);

  useEffect(() => {
    writeSessionTabs(sessionTabs);
  }, [sessionTabs]);

  useEffect(() => {
    writeSessionPanes(sessionPanes);
  }, [sessionPanes]);

  // Keep the active ACP session mirrored in the tab strip + focused pane.
  useEffect(() => {
    if (!state.sessionId) return;
    setSessionTabs((prev) => openSessionTab(prev, state.sessionId!));
    setSessionPanes((prev) =>
      bindFocusedPaneSession(prev, state.sessionId),
    );
  }, [state.sessionId]);

  // Drop tabs for deleted sessions.
  useEffect(() => {
    if (sessions.length === 0) return;
    const existing = new Set(sessions.map((s) => s.id));
    setSessionTabs((prev) => pruneSessionTabs(prev, existing));
    setSessionPanes((prev) => prunePaneSessions(prev, existing));
  }, [sessions]);

  // Narrow viewports: auto-collapse side rails.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 900px)");
    const sync = (): void => {
      if (mq.matches) {
        setSidebarCollapsed(true);
        setDetailsCollapsed(true);
      }
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (
        e.key === "Escape" &&
        state.busy &&
        !state.permission &&
        !state.userQuestion
      ) {
        e.preventDefault();
        void host.cancel();
        return;
      }
      if (e.key.toLowerCase() === "k" && isPrimaryMod(e) && !e.shiftKey) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        document.getElementById("eh-composer")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [host, state.busy, state.permission, state.userQuestion]);

  useEffect(() => {
    setProviderDraft(state.provider);
    setModelDraft(state.model);
    setBaseUrlDraft(state.baseUrl);
    setDecisionEndpointDraft(state.decisionEndpoint);
  }, [state.provider, state.model, state.baseUrl, state.decisionEndpoint]);

  const refreshSessions = useCallback(() => {
    if (!state.ready) return;
    void host.listSessions().then(setSessions).catch(() => setSessions([]));
  }, [host, state.ready]);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions, state.sessionId]);

  const refreshWorkspaces = useCallback(() => {
    if (!state.ready) {
      setWorkspaces([]);
      return;
    }
    void host
      .listWorkspaces()
      .then(setWorkspaces)
      .catch(() => setWorkspaces([]));
  }, [host, state.ready]);

  useEffect(() => {
    refreshWorkspaces();
  }, [refreshWorkspaces, state.sessionId]);

  const startSessionIn = useCallback(
    (cwd: string): void => {
      drainHaltRef.current = false;
      setPromptQueue([]);
      void host
        .newSession(cwd)
        .then(() => {
          setEhuiRefresh((n) => n + 1);
          refreshSessions();
          refreshWorkspaces();
        })
        .catch(() => undefined);
    },
    [host, refreshSessions, refreshWorkspaces],
  );

  const ehuiSource = useMemo(() => {
    if (!state.sessionId || !state.ready) return null;
    return createBrowserEhuiDataSource(host, state.sessionId);
  }, [host, state.sessionId, state.ready]);

  const runPrompt = useCallback(
    async (
      text: string,
      content?: Parameters<AcpHost["prompt"]>[1],
    ): Promise<void> => {
      await host.prompt(text, content);
      setEhuiRefresh((n) => n + 1);
      refreshSessions();
      void host.refreshContext();
    },
    [host, refreshSessions],
  );

  useEffect(() => {
    if (!state.ready || !state.sessionId) return;
    void host.refreshContext();
  }, [host, state.ready, state.sessionId]);

  const hostPromptBlocked = Boolean(state.permission || state.userQuestion);

  const sendWithAttachments = useCallback(async (): Promise<void> => {
    const text = draft.trim();
    if (
      (!text && attachments.length === 0) ||
      !state.ready ||
      hostPromptBlocked
    ) {
      return;
    }
    drainHaltRef.current = false;
    setAttachError(null);

    const files = attachments.filter((a) => a.kind === "file");
    const images = attachments.filter((a) => a.kind === "image");
    const paths: string[] = [];
    for (const f of files) {
      const res = await host.attachFile({
        name: f.name,
        dataBase64: f.dataBase64,
        mimeType: f.mimeType,
      });
      paths.push(res.relativePath);
    }
    const payload = buildPromptPayload(text, images, paths);
    const footnote = attachmentFootnote(images, paths);
    const display =
      footnote.length > 0
        ? `${payload.text}${payload.text ? "\n" : ""}${footnote}`
        : payload.text;

    const queued: QueuedPrompt = {
      text: display,
      ...(payload.content !== undefined ? { content: payload.content } : {}),
    };
    if (state.busy || drainingRef.current) {
      setPromptQueue((q) => [...q, queued]);
      setDraft("");
      setAttachments([]);
      return;
    }
    setDraft("");
    setAttachments([]);
    await runPrompt(display, payload.content);
  }, [
    draft,
    attachments,
    state.ready,
    state.busy,
    hostPromptBlocked,
    host,
    runPrompt,
  ]);

  const enqueueOrSend = useCallback((): void => {
    void sendWithAttachments().catch((err) => {
      setAttachError(err instanceof Error ? err.message : String(err));
    });
  }, [sendWithAttachments]);

  // Feed Terminal tab from status/tool transcript lines.
  useEffect(() => {
    const last = state.messages[state.messages.length - 1];
    if (!last) return;
    if (last.role !== "status" && last.role !== "tool") return;
    setTerminalLines((prev) => {
      const line = last.text.trim();
      if (!line || prev[prev.length - 1] === line) return prev;
      return [...prev.slice(-200), line];
    });
  }, [state.messages]);

  const clearQueue = useCallback((): void => {
    drainHaltRef.current = false;
    setPromptQueue([]);
  }, []);

  const removeQueueItem = useCallback((index: number): void => {
    drainHaltRef.current = false;
    setPromptQueue((q) => q.filter((_, i) => i !== index));
  }, []);

  const editQueueItem = useCallback((index: number): void => {
    drainHaltRef.current = false;
    setPromptQueue((q) => {
      const item = q[index];
      if (item === undefined) return q;
      setDraft(item.text);
      queueMicrotask(() => document.getElementById("eh-composer")?.focus());
      return q.filter((_, i) => i !== index);
    });
  }, []);

  const insertComposerHint = useCallback((text: string): void => {
    setDraft((d) => (d.trim() === "" ? text : `${d.trimEnd()}\n${text}`));
    queueMicrotask(() => document.getElementById("eh-composer")?.focus());
  }, []);

  const requestDetailsFocus = useCallback(
    (partial: Omit<DetailsFocusRequest, "seq">): void => {
      detailsFocusSeq.current += 1;
      setDetailsCollapsed(false);
      setDetailsFocus({ ...partial, seq: detailsFocusSeq.current });
      setEhuiRefresh((n) => n + 1);
    },
    [],
  );

  const openChangedPath = useCallback(
    (path: string): void => {
      requestDetailsFocus({ tab: "preview", previewPath: path });
    },
    [requestDetailsFocus],
  );

  const openGitDiff = useCallback((): void => {
    requestDetailsFocus({ tab: "tools", ehuiPanel: "git-diff" });
  }, [requestDetailsFocus]);

  // Drain one queued prompt when the agent becomes idle.
  useEffect(() => {
    if (
      state.busy ||
      !state.ready ||
      state.permission ||
      state.userQuestion ||
      promptQueue.length === 0 ||
      drainingRef.current ||
      drainHaltRef.current
    ) {
      return;
    }
    const next = promptQueue[0]!;
    drainingRef.current = true;
    void runPrompt(next.text, next.content)
      .then(() => {
        setPromptQueue((q) => (q[0] === next ? q.slice(1) : q));
      })
      .catch(() => {
        // Keep the item at the front; halt so we don't spin on a hard fail.
        drainHaltRef.current = true;
      })
      .finally(() => {
        drainingRef.current = false;
      });
  }, [
    state.busy,
    state.ready,
    state.permission,
    state.userQuestion,
    promptQueue,
    runPrompt,
  ]);

  const saveActiveTabDraft = useCallback((): void => {
    const id = state.sessionId;
    if (!id) return;
    tabDraftsRef.current.set(id, {
      draft,
      attachments,
      queue: promptQueue,
    });
  }, [state.sessionId, draft, attachments, promptQueue]);

  const restoreTabDraft = useCallback((id: string): void => {
    const cached = tabDraftsRef.current.get(id);
    setDraft(cached?.draft ?? "");
    setAttachments(cached?.attachments ?? []);
    setPromptQueue(cached?.queue ?? []);
    drainHaltRef.current = false;
  }, []);

  const switchToSession = useCallback(
    (id: string): void => {
      if (id === state.sessionId) return;
      saveActiveTabDraft();
      void host.switchSession(id).then(() => {
        restoreTabDraft(id);
        setEhuiRefresh((n) => n + 1);
        void host.refreshContext();
      });
    },
    [host, state.sessionId, saveActiveTabDraft, restoreTabDraft],
  );

  const onResume = (id: string): void => {
    saveActiveTabDraft();
    setSessionTabs((prev) => openSessionTab(prev, id));
    setSessionPanes((prev) => bindFocusedPaneSession(prev, id));
    void host.resumeSession(id).then(() => {
      restoreTabDraft(id);
      setEhuiRefresh((n) => n + 1);
      refreshSessions();
      void host.refreshContext();
    });
  };

  const activateSessionInFocus = useCallback(
    (id: string): void => {
      setSessionTabs((prev) => setActiveSessionTab(openSessionTab(prev, id), id));
      setSessionPanes((prev) => bindFocusedPaneSession(prev, id));
      switchToSession(id);
    },
    [switchToSession],
  );

  const onSelectTab = useCallback(
    (id: string): void => {
      activateSessionInFocus(id);
    },
    [activateSessionInFocus],
  );

  const onFocusLeaf = useCallback(
    (leafId: string): void => {
      setSessionPanes((prev) => {
        if (prev.focusLeafId === leafId) return prev;
        const next = setPaneFocus(prev, leafId);
        const sid = focusedPaneSessionId(next);
        if (sid !== null) {
          setSessionTabs((tabs) =>
            setActiveSessionTab(openSessionTab(tabs, sid), sid),
          );
          if (sid !== state.sessionId) {
            saveActiveTabDraft();
            void host.switchSession(sid).then(() => {
              restoreTabDraft(sid);
              setEhuiRefresh((n) => n + 1);
              void host.refreshContext();
            });
          }
        }
        return next;
      });
    },
    [host, state.sessionId, saveActiveTabDraft, restoreTabDraft],
  );

  const onSplitLeaf = useCallback(
    (leafId: string, direction: SplitDirection): void => {
      setSessionPanes((prev) => {
        const focused = setPaneFocus(prev, leafId);
        const active = focusedPaneSessionId(focused);
        const partner = pickSplitPartner(active, sessionTabs.openIds);
        return splitFocusedLeaf(focused, direction, partner);
      });
    },
    [sessionTabs.openIds],
  );

  const onUnsplitLeaf = useCallback(
    (leafId: string): void => {
      setSessionPanes((prev) => {
        const next = unsplitFocused(setPaneFocus(prev, leafId));
        const sid = focusedPaneSessionId(next);
        if (sid !== null && sid !== state.sessionId) {
          setSessionTabs((tabs) =>
            setActiveSessionTab(openSessionTab(tabs, sid), sid),
          );
          saveActiveTabDraft();
          void host.switchSession(sid).then(() => {
            restoreTabDraft(sid);
            setEhuiRefresh((n) => n + 1);
            void host.refreshContext();
          });
        }
        return next;
      });
    },
    [host, state.sessionId, saveActiveTabDraft, restoreTabDraft],
  );

  const onSplitDirection = useCallback(
    (direction: SplitDirection): void => {
      setSessionPanes((prev) => {
        const active = focusedPaneSessionId(prev);
        const partner = pickSplitPartner(active, sessionTabs.openIds);
        return splitFocusedLeaf(prev, direction, partner);
      });
    },
    [sessionTabs.openIds],
  );

  const onUnsplitAll = useCallback((): void => {
    setSessionPanes((prev) => collapseToFocused(prev));
  }, []);

  const onSelectLeafTab = useCallback(
    (leafId: string, sessionId: string): void => {
      setSessionPanes((prev) => activateLeafTab(prev, leafId, sessionId));
      setSessionTabs((prev) =>
        setActiveSessionTab(openSessionTab(prev, sessionId), sessionId),
      );
      switchToSession(sessionId);
    },
    [switchToSession],
  );

  const onCloseLeafTab = useCallback(
    (leafId: string, sessionId: string): void => {
      setSessionPanes((prev) => {
        const next = closeLeafTab(prev, leafId, sessionId);
        // Only drop the window-level tab when no pane still shows it.
        if (!sessionOpenInAnyLeaf(next, sessionId)) {
          tabDraftsRef.current.delete(sessionId);
          setSessionTabs((tabs) => closeSessionTab(tabs, sessionId));
        }
        const leaf = findLeaf(next.root, leafId) ?? focusedLeaf(next);
        if (
          leafId === next.focusLeafId &&
          leaf.activeId !== null &&
          leaf.activeId !== state.sessionId
        ) {
          setSessionTabs((tabs) =>
            setActiveSessionTab(tabs, leaf.activeId!),
          );
          saveActiveTabDraft();
          void host.switchSession(leaf.activeId).then(() => {
            restoreTabDraft(leaf.activeId!);
            setEhuiRefresh((n) => n + 1);
          });
        }
        return next;
      });
    },
    [host, state.sessionId, saveActiveTabDraft, restoreTabDraft],
  );

  const onCloseTab = useCallback(
    (id: string): void => {
      onCloseLeafTab(sessionPanes.focusLeafId, id);
    },
    [onCloseLeafTab, sessionPanes.focusLeafId],
  );

  const onNewTabInLeaf = useCallback(
    (leafId: string): void => {
      setSessionPanes((prev) => setPaneFocus(prev, leafId));
      saveActiveTabDraft();
      drainHaltRef.current = false;
      setPromptQueue([]);
      setDraft("");
      setAttachments([]);
      void host.newSession(state.cwd || undefined).then(() => {
        setEhuiRefresh((n) => n + 1);
        refreshSessions();
      });
    },
    [host, state.cwd, saveActiveTabDraft, refreshSessions],
  );

  const onNewTab = useCallback((): void => {
    onNewTabInLeaf(sessionPanes.focusLeafId);
  }, [onNewTabInLeaf, sessionPanes.focusLeafId]);

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
          pinnedIds={pinnedIds}
          archivedIds={archivedIds}
          onTogglePin={(id) => {
            setPinnedIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          }}
          onToggleArchive={(id) => {
            setArchivedIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          }}
          onRename={(id, title) => {
            const run = async (): Promise<void> => {
              if (state.sessionId !== id) {
                // resumeSession cancels an in-flight turn — refuse while busy.
                if (state.busy) return;
                drainHaltRef.current = false;
                setPromptQueue([]);
                await host.resumeSession(id);
              }
              await host.prompt(`/rename ${title}`);
              refreshSessions();
            };
            void run().catch(() => undefined);
          }}
          onDelete={(id) => {
            void host
              .deleteSession(id)
              .then((deleted) => {
                if (!deleted) return;
                setPinnedIds((prev) => {
                  const next = new Set(prev);
                  next.delete(id);
                  return next;
                });
                setArchivedIds((prev) => {
                  const next = new Set(prev);
                  next.delete(id);
                  return next;
                });
                if (state.sessionId === id) {
                  drainHaltRef.current = false;
                  setPromptQueue([]);
                  void host.newSession().then(() => {
                    setEhuiRefresh((n) => n + 1);
                    refreshSessions();
                  });
                } else {
                  refreshSessions();
                }
              })
              .catch(() => undefined);
          }}
          onNewSession={() => {
            drainHaltRef.current = false;
            setPromptQueue([]);
            void host.newSession().then(() => {
              setEhuiRefresh((n) => n + 1);
              refreshSessions();
            });
          }}
          onNewSessionIn={startSessionIn}
          onOpenProjects={() => setProjectsOpen(true)}
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
          <SessionTabsBar
            tabs={
              isSplitLayout(sessionPanes)
                ? []
                : sessionTabs.openIds.map((id) => {
                    const s = sessions.find((x) => x.id === id);
                    return {
                      id,
                      title: s?.title?.trim() || id.slice(0, 8),
                      busy: state.busySessionIds.includes(id),
                    };
                  })
            }
            activeId={sessionTabs.activeId}
            onSelect={onSelectTab}
            onClose={onCloseTab}
            onNew={onNewTab}
            splitActive={isSplitLayout(sessionPanes)}
            onSplitDirection={onSplitDirection}
            {...(isSplitLayout(sessionPanes)
              ? { onUnsplitAll }
              : {})}
          />
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
              <span title={state.cwd}>
                {shortPathLabel(state.cwd || "")}
              </span>
              <span className="sep">·</span>
              <span>
                mesh {state.mesh?.connected ?? state.peerCount}/
                {state.mesh?.peerTotal ?? state.peerCount}
              </span>
              <span className="sep">·</span>
              <span className={state.busy ? "busy" : ""}>
                {state.busy ? "busy" : "idle"}
              </span>
              {promptQueue.length > 0 ? (
                <>
                  <span className="sep">·</span>
                  <span className="busy">{promptQueue.length} queued</span>
                </>
              ) : null}
              {isSplitLayout(sessionPanes) ? (
                <>
                  <span className="sep">·</span>
                  <span>
                    split · {leafCount(sessionPanes)} panes
                  </span>
                </>
              ) : null}
            </div>
            <button
              type="button"
              disabled={!state.busy}
              onClick={() => void host.cancel()}
              title="Stop (Esc)"
              aria-keyshortcuts="Escape"
            >
              Stop
            </button>
          </header>

          <ContextChrome
            ready={state.ready}
            busy={state.busy}
            stats={state.contextStats}
            onRefresh={() => void host.refreshContext()}
            onCompact={() => {
              void host
                .compactSession(6)
                .then(() => {
                  refreshSessions();
                })
                .catch(() => undefined);
            }}
          />

          <ChatSplit
            root={sessionPanes.root}
            focusLeafId={sessionPanes.focusLeafId}
            canUnsplit={leafCount(sessionPanes) > 1}
            onFocusLeaf={onFocusLeaf}
            onRatio={(splitId, ratio) =>
              setSessionPanes((prev) => setSplitRatio(prev, splitId, ratio))
            }
            onSelectTab={onSelectLeafTab}
            onCloseTab={onCloseLeafTab}
            onNewTab={onNewTabInLeaf}
            onSplitLeaf={onSplitLeaf}
            onUnsplitLeaf={onUnsplitLeaf}
            error={state.error}
            showConnectionError={state.connectionState === "connected"}
            leafModels={(() => {
              // Depend on sessionCacheEpoch so background panes refresh.
              void state.sessionCacheEpoch;
              const map = new Map<
                string,
                {
                  leafId: string;
                  sessionId: string | null;
                  title: string;
                  messages: typeof state.messages;
                  busy: boolean;
                  tabs: Array<{
                    id: string;
                    title: string;
                    busy?: boolean;
                  }>;
                  empty: JSX.Element;
                }
              >();
              for (const leaf of listLeaves(sessionPanes.root)) {
                const sid = leaf.activeId;
                const s = sid ? sessions.find((x) => x.id === sid) : undefined;
                const messages =
                  sid === state.sessionId
                    ? state.messages
                    : host.peekSessionMessages(sid);
                map.set(leaf.id, {
                  leafId: leaf.id,
                  sessionId: sid,
                  title:
                    s?.title?.trim() || (sid ? sid.slice(0, 8) : "Empty"),
                  messages,
                  busy: sid ? state.busySessionIds.includes(sid) : false,
                  tabs: leaf.openIds.map((id) => {
                    const t = sessions.find((x) => x.id === id);
                    return {
                      id,
                      title: t?.title?.trim() || id.slice(0, 8),
                      busy: state.busySessionIds.includes(id),
                    };
                  }),
                  empty: (
                    <EmptyHero
                      ready={state.ready}
                      sessionId={sid}
                      cwd={state.cwd}
                      onOpenProject={() => setProjectsOpen(true)}
                    />
                  ),
                });
              }
              return map;
            })()}
          />

          {state.permission ? (
            <PermissionDock
              permission={state.permission}
              loadBefore={async (p) => {
                try {
                  const res = await host.readFs(p);
                  if (res.binary || res.text === undefined) return null;
                  return res.text;
                } catch {
                  return null;
                }
              }}
            />
          ) : null}

          <QueuePanel
            items={promptQueue}
            onRemove={removeQueueItem}
            onClear={clearQueue}
            onEdit={editQueueItem}
          />

          <ContextStrip
            cwd={state.cwd}
            attachedNames={attachments.map((a) => a.name)}
            touchedPaths={state.changedFiles}
            onOpenPath={openChangedPath}
          />

          <ChangesDock
            paths={state.changedFiles}
            onOpenGitDiff={openGitDiff}
            onOpenPath={openChangedPath}
            onDismiss={() => host.clearChangedFiles()}
          />

          <TurnHintsDock
            hints={state.turnHints}
            onFollowUp={insertComposerHint}
            onDismiss={() => host.clearTurnHints()}
          />

          <Composer
            draft={draft}
            onDraftChange={setDraft}
            ready={state.ready}
            busy={state.busy}
            blocked={hostPromptBlocked}
            enterBehavior={enterBehavior}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            attachError={attachError}
            onAttachError={setAttachError}
            onSubmit={enqueueOrSend}
            onCancel={() => void host.cancel()}
            onHint={insertComposerHint}
            {...(state.slashCatalog !== null
              ? { slashCatalog: state.slashCatalog }
              : {})}
          />
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
          onSendAgentMessage={(agentId, message) =>
            host.sendAgentMessage(agentId, message)
          }
          onInterruptAgent={(agentId) => host.interruptAgent(agentId)}
          ehuiSource={ehuiSource}
          ehuiRefresh={ehuiRefresh}
          onResumeSession={(id) => {
            onResume(id);
          }}
          collapsed={detailsCollapsed}
          onToggleCollapsed={() => setDetailsCollapsed((v) => !v)}
          sessionReady={state.ready && Boolean(state.sessionId)}
          listFs={(path) => host.listFs(path)}
          readFs={(path) => host.readFs(path)}
          onAttachPath={(path) => {
            setDraft((d) =>
              d.trim() === "" ? `Attached: ${path}` : `${d.trimEnd()}\nAttached: ${path}`,
            );
            queueMicrotask(() =>
              document.getElementById("eh-composer")?.focus(),
            );
          }}
          terminalLines={terminalLines}
          onClearTerminal={() => setTerminalLines([])}
          host={host}
          cwd={state.cwd}
          focusRequest={detailsFocus}
        />
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        providerDraft={providerDraft}
        modelDraft={modelDraft}
        baseUrlDraft={baseUrlDraft}
        onProviderDraft={setProviderDraft}
        onModelDraft={setModelDraft}
        onBaseUrlDraft={setBaseUrlDraft}
        onApplyModel={() =>
          void host
            .setModel(
              providerDraft.trim(),
              modelDraft.trim(),
              baseUrlDraft.trim() || undefined,
            )
            .catch(() => undefined)
        }
        sandbox={state.sandbox}
        approval={state.approval}
        autoRun={state.autoRun}
        onPolicy={(partial) =>
          void host.setPolicy(partial).catch(() => undefined)
        }
        decisionMode={state.decisionMode}
        decisionBackend={state.decisionBackend}
        decisionEndpointDraft={decisionEndpointDraft}
        onDecisionEndpointDraft={setDecisionEndpointDraft}
        onDecision={(partial) =>
          void host.setDecision(partial).catch(() => undefined)
        }
        theme={theme}
        onTheme={setTheme}
        enterBehavior={enterBehavior}
        onEnterBehavior={setEnterBehavior}
        fontSizePx={fontSizePx}
        onFontSizePx={setFontSizePx}
      />

      <ProjectPickerModal
        open={projectsOpen}
        onClose={() => setProjectsOpen(false)}
        workspaces={workspaces}
        activeCwd={state.cwd}
        onAdd={async (path, name) => {
          await host.addWorkspace(path, name === "" ? undefined : name);
          refreshWorkspaces();
        }}
        onRemove={async (path) => {
          await host.removeWorkspace(path);
          refreshWorkspaces();
        }}
        onOpen={(path) => {
          startSessionIn(path);
          setProjectsOpen(false);
        }}
      />

      <AskUserModal
        userQuestion={state.userQuestion}
        questionDraft={questionDraft}
        onQuestionDraft={setQuestionDraft}
      />
    </div>
  );
}
