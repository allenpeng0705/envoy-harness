/**
 * TuiSession — ACP-backed controller (IO-free for hermetic tests).
 */

import type {
  ClientClusterStatus,
  ClientDiscoveryEvent,
  ClientPeerInfo,
  ClientScoreboardEntry,
  ClientTeamJob,
  EnvoyHarnessClient,
} from "@envoymesh/envoy-harness-client";
import { hasTurnHints, type TurnHints } from "@envoymesh/envoy-harness";

import { parseSlash } from "./slash.js";
import type { ActivityLike } from "./activity.js";
import {
  connectMeshPeerImpl,
  getModelLabelImpl,
  listPeersImpl,
  noteDiscoveryEventImpl,
  peersImpl,
  refreshClusterImpl,
  routeImpl,
  scoreboardImpl,
  showClusterStatusImpl,
  showRouteImpl,
  showScoreboardImpl,
  showSearchImpl,
  showTeamJobsImpl,
  showTraceImpl,
  subscribeDiscoveryImpl,
  teamJobsImpl,
} from "./session-cluster-mesh.js";
import {
  buildClusterCtx,
  buildProtocolState,
  buildSink,
  buildWorkspaceCtx,
  type SessionClusterCtx,
  type SessionSink,
  type SessionWorkspaceCtx,
} from "./session-context.js";
import {
  answerPermissionImpl,
  answerUserQuestionImpl,
  handlePermissionRequestImpl,
  handleUserQuestionRequestImpl,
  scrollPermissionPreviewImpl,
  type PermissionWaiter,
  type UserQuestionWaiter,
} from "./session-permissions.js";
import {
  clearStreamingAssistantImpl,
  consumeProtocolMessageImpl,
  handleSessionActivityImpl,
  handleSessionTokenImpl,
  handleSessionUpdateImpl,
  pushActivityImpl,
} from "./session-protocol.js";
import { dispatchSlashImpl } from "./session-slash-dispatch.js";
import {
  clearTranscriptImpl,
  showConfigImpl,
  showContextImpl,
  showCostImpl,
  showModelUsageImpl,
  showSessionInfoImpl,
  showStatusImpl,
  showToolsImpl,
} from "./session-info.js";
import {
  runCompactImpl,
  runSetApprovalImpl,
  runSetAutoRunImpl,
  runSetProviderImpl,
  runSetSandboxImpl,
} from "./session-policy.js";
import {
  fetchGitDiffViewImpl,
  fetchMemoryViewImpl,
  fetchPlanViewImpl,
  listPersistedSessionsImpl,
  newSessionImpl,
  resumeSessionImpl,
  runInitImpl,
  runMemoryImpl,
  runModeImpl,
  runPlanImpl,
  runReviewImpl,
  setGitDiffFlagsImpl,
  showAgentsImpl,
  showGitDiffImpl,
  showGitStatusImpl,
  showHooksImpl,
  showMcpImpl,
} from "./session-workspace.js";
import {
  formatTranscriptLine,
  type TranscriptFormatOptions,
  type TranscriptLine,
  type TranscriptRole,
} from "./transcript.js";

export type {
  PermissionRequest,
  TuiSessionOptions,
  UserQuestionAnswer,
  UserQuestionRequest,
} from "./session-types.js";

import type {
  PermissionRequest,
  TuiSessionOptions,
  UserQuestionAnswer,
  UserQuestionRequest,
} from "./session-types.js";

export class TuiSession {
  readonly #client: EnvoyHarnessClient;
  readonly #cwd: string | undefined;
  readonly #initialAutoRun: "safe-only" | "always-confirm" | "off" | undefined;
  #onTranscript: ((lines: readonly TranscriptLine[]) => void) | undefined;
  readonly #onPermission:
    | ((req: PermissionRequest) => Promise<"allow" | "deny">)
    | undefined;
  readonly #onUserQuestion:
    | ((req: UserQuestionRequest) => Promise<UserQuestionAnswer>)
    | undefined;
  readonly #lines: TranscriptLine[] = [];
  #sessionId: string | undefined;
  #busy = false;
  readonly #turnSeen = new Set<string>();
  #turnToolActivityLines = 0;
  readonly #turnActivityLineIndices: number[] = [];
  #streamingAssistantText = "";
  #streamingAssistantLineIndex: number | undefined;
  readonly #removeSessionToken: () => void;
  readonly #removeSessionUpdate: () => void;
  readonly #removeSessionActivity: () => void;
  #lastTurnCostUsd: number | undefined;
  #clusterSnapshot: ClientClusterStatus | undefined;
  readonly #discoveryEvents: ClientDiscoveryEvent[] = [];
  #gitDiffStaged = false;
  #gitDiffStat = false;
  #imagesSupported = false;
  #permissionWaiter: PermissionWaiter | undefined;
  #userQuestionWaiter: UserQuestionWaiter | undefined;
  #turnHints: TurnHints | undefined;
  #transcriptFormat: TranscriptFormatOptions;
  readonly #inputQueue: string[] = [];

  constructor(options: TuiSessionOptions) {
    this.#client = options.client;
    this.#cwd = options.cwd;
    this.#initialAutoRun = options.initialAutoRun;
    this.#onTranscript = options.onTranscript;
    this.#onPermission = options.onPermission;
    this.#onUserQuestion = options.onUserQuestion;
    this.#transcriptFormat = options.transcriptFormat ?? {};
    this.#removeSessionUpdate = this.#client.onNotification(
      "session/update",
      (params) => this.#handleSessionUpdate(params),
    );
    this.#removeSessionToken = this.#client.onNotification(
      "session/token",
      (params) => this.#handleSessionToken(params),
    );
    const unsubActivity = this.#client.onNotification(
      "session/activity",
      (params) => this.#handleSessionActivity(params),
    );
    const unsubSdkEvent = this.#client.onNotification(
      "session/event",
      (params) => {
        const p = params as {
          type?: string;
          activity?: ActivityLike;
          token?: { role?: string; delta?: string };
        };
        if (p.type === "activity" && p.activity !== undefined) {
          this.#pushActivity(p.activity);
        } else if (p.type === "token" && p.token !== undefined) {
          this.#handleSessionToken({ token: p.token });
        }
      },
    );
    this.#removeSessionActivity = () => {
      unsubActivity();
      unsubSdkEvent();
    };
  }

  #basicRefs() {
    const s = this;
    return {
      client: s.#client,
      push: (role: TranscriptRole, text: string) => s.#push(role, text),
      getSessionId: () => s.#sessionId,
      getBusy: () => s.#busy,
    };
  }

  #sink(): SessionSink {
    return buildSink(this.#basicRefs());
  }

  #clusterCtx(): SessionClusterCtx {
    const s = this;
    return buildClusterCtx({
      ...this.#basicRefs(),
      getClusterSnapshot: () => s.#clusterSnapshot,
      setClusterSnapshot: (v) => {
        s.#clusterSnapshot = v;
      },
      discoveryEvents: s.#discoveryEvents,
      lines: s.#lines,
      transcriptFormat: s.#transcriptFormat,
    });
  }

  #workspaceCtx(): SessionWorkspaceCtx {
    const s = this;
    return buildWorkspaceCtx({
      ...this.#basicRefs(),
      setSessionId: (v) => {
        s.#sessionId = v;
      },
      cwd: s.#cwd,
      initialAutoRun: s.#initialAutoRun,
      lines: s.#lines,
      onTranscript: s.#onTranscript,
      turnSeen: s.#turnSeen,
      getLastTurnCostUsd: () => s.#lastTurnCostUsd,
      setLastTurnCostUsd: (v) => {
        s.#lastTurnCostUsd = v;
      },
      getGitDiffStaged: () => s.#gitDiffStaged,
      setGitDiffStaged: (v) => {
        s.#gitDiffStaged = v;
      },
      getGitDiffStat: () => s.#gitDiffStat,
      setGitDiffStat: (v) => {
        s.#gitDiffStat = v;
      },
    });
  }

  #protocolState() {
    const s = this;
    return buildProtocolState({
      getSessionId: () => s.#sessionId,
      getBusy: () => s.#busy,
      lines: s.#lines,
      onTranscript: s.#onTranscript,
      turnSeen: s.#turnSeen,
      turnActivityLineIndices: s.#turnActivityLineIndices,
      getTurnToolActivityLines: () => s.#turnToolActivityLines,
      setTurnToolActivityLines: (v) => {
        s.#turnToolActivityLines = v;
      },
      getStreamingAssistantText: () => s.#streamingAssistantText,
      setStreamingAssistantText: (v) => {
        s.#streamingAssistantText = v;
      },
      getStreamingAssistantLineIndex: () => s.#streamingAssistantLineIndex,
      setStreamingAssistantLineIndex: (v) => {
        s.#streamingAssistantLineIndex = v;
      },
      getLastTurnCostUsd: () => s.#lastTurnCostUsd,
      setLastTurnCostUsd: (v) => {
        s.#lastTurnCostUsd = v;
      },
      getTurnHints: () => s.#turnHints,
      setTurnHints: (v) => {
        s.#turnHints = v;
      },
    });
  }

  #permissionOpts() {
    const s = this;
    return {
      push: (role: TranscriptRole, text: string) => s.#push(role, text),
      cwd: s.#cwd,
      transcriptFormat: s.#transcriptFormat,
      onPermission: s.#onPermission,
      setWaiter: (w: PermissionWaiter | undefined) => {
        s.#permissionWaiter = w;
      },
      getWaiter: () => s.#permissionWaiter,
      onUserQuestion: s.#onUserQuestion,
      setQuestionWaiter: (w: UserQuestionWaiter | undefined) => {
        s.#userQuestionWaiter = w;
      },
      getQuestionWaiter: () => s.#userQuestionWaiter,
    };
  }

  setOnTranscript(
    cb: (lines: readonly TranscriptLine[]) => void,
  ): void {
    this.#onTranscript = cb;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get busy(): boolean {
    return this.#busy;
  }

  get turnHints(): TurnHints | undefined {
    return this.#turnHints;
  }

  clearTurnHints(): void {
    this.#turnHints = undefined;
  }

  get transcript(): readonly TranscriptLine[] {
    return this.#lines;
  }

  get pendingPermission(): PermissionRequest | undefined {
    return this.#permissionWaiter?.req;
  }

  get pendingUserQuestion(): UserQuestionRequest | undefined {
    return this.#userQuestionWaiter?.req;
  }

  get clusterSnapshot(): ClientClusterStatus | undefined {
    return this.#clusterSnapshot;
  }

  get discoveryEvents(): readonly ClientDiscoveryEvent[] {
    return [...this.#discoveryEvents];
  }

  get gitDiffStaged(): boolean {
    return this.#gitDiffStaged;
  }

  get gitDiffStat(): boolean {
    return this.#gitDiffStat;
  }

  get imagesSupported(): boolean {
    return this.#imagesSupported;
  }

  get queuedInputCount(): number {
    return this.#inputQueue.length;
  }

  dropQueuedInput(index: number): boolean {
    if (index < 0 || index >= this.#inputQueue.length) return false;
    this.#inputQueue.splice(index, 1);
    return true;
  }

  clearQueuedInput(): void {
    this.#inputQueue.length = 0;
  }

  setTranscriptFormat(options: TranscriptFormatOptions): void {
    this.#transcriptFormat = options;
  }

  handlePermissionRequest(
    req: PermissionRequest,
  ): Promise<"allow" | "deny"> {
    const opts = this.#permissionOpts();
    return handlePermissionRequestImpl(req, {
      onPermission: opts.onPermission,
      push: opts.push,
      cwd: opts.cwd,
      transcriptFormat: opts.transcriptFormat,
      setWaiter: opts.setWaiter,
      getWaiter: opts.getWaiter,
    });
  }

  answerPermission(decision: "allow" | "deny"): boolean {
    const opts = this.#permissionOpts();
    return answerPermissionImpl(decision, {
      getWaiter: opts.getWaiter,
      setWaiter: opts.setWaiter,
      push: opts.push,
    });
  }

  /** U6a.4 — scroll permission diff preview (j/k / PgDn/PgUp). */
  scrollPermissionPreview(delta: number): boolean {
    return scrollPermissionPreviewImpl(delta, this.#permissionOpts());
  }

  handleUserQuestionRequest(
    req: UserQuestionRequest,
  ): Promise<UserQuestionAnswer> {
    const opts = this.#permissionOpts();
    return handleUserQuestionRequestImpl(req, {
      onUserQuestion: opts.onUserQuestion,
      push: opts.push,
      setWaiter: opts.setQuestionWaiter,
    });
  }

  answerUserQuestion(answer: UserQuestionAnswer): boolean {
    const opts = this.#permissionOpts();
    return answerUserQuestionImpl(answer, {
      getWaiter: opts.getQuestionWaiter,
      setWaiter: opts.setQuestionWaiter,
      push: opts.push,
    });
  }

  cancelUserQuestion(): boolean {
    return this.answerUserQuestion({ value: "", cancelled: true });
  }

  async start(): Promise<void> {
    const init = await this.#client.initialize();
    this.#imagesSupported =
      init.capabilities?.promptCapabilities?.image === true;
    this.#push(
      "status",
      `ACP protocol v${init.protocolVersion} — /help for commands`,
    );
    const created = await this.#client.acpNewSession(
      this.#cwd !== undefined ? { cwd: this.#cwd } : undefined,
    );
    this.#sessionId = created.sessionId;
    if (this.#initialAutoRun !== undefined) {
      try {
        await this.#client.setSessionPolicy(created.sessionId, {
          autoRun: this.#initialAutoRun,
        });
      } catch {
        // Best-effort — the policy is a convenience, not a hard requirement.
      }
    }
    this.#push("system", `session ${created.sessionId}`);
  }

  async submit(line: string): Promise<"ok" | "quit"> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return "ok";

    const slash = parseSlash(trimmed);
    if (slash !== null) {
      return dispatchSlashImpl(
        (role, text) => this.#push(role, text),
        this,
        slash,
      );
    }

    if (this.#sessionId === undefined) {
      this.#push("status", "not started — call start() first");
      return "ok";
    }
    if (this.#busy) {
      this.#inputQueue.push(trimmed);
      this.#push(
        "status",
        `queued (${this.#inputQueue.length}): ${trimmed.length > 72 ? `${trimmed.slice(0, 72)}…` : trimmed}`,
      );
      return "ok";
    }

    await this.#runUserPrompt(trimmed);
    return "ok";
  }

  async #runUserPrompt(trimmed: string): Promise<void> {
    if (this.#sessionId === undefined) return;
    this.#push("user", trimmed);
    this.#busy = true;
    this.#turnHints = undefined;
    this.#turnSeen.clear();
    this.#turnToolActivityLines = 0;
    this.#turnActivityLineIndices.length = 0;
    this.#streamingAssistantText = "";
    this.#streamingAssistantLineIndex = undefined;
    try {
      const result = await this.#client.prompt(this.#sessionId, trimmed);
      for (const msg of result.messages) {
        this.#consumeProtocolMessage(msg);
      }
      if (result.turnHints !== undefined && hasTurnHints(result.turnHints)) {
        this.#turnHints = result.turnHints;
        if (result.turnHints.deferred !== undefined) {
          for (const item of result.turnHints.deferred) {
            this.#push("status", `deferred: ${item.task} — ${item.reason}`);
          }
        }
      }
      this.#push("status", `stop: ${result.stopReason}`);
    } catch (err) {
      this.#push("status", `error: ${(err as Error).message}`);
    } finally {
      this.#busy = false;
      this.#turnToolActivityLines = 0;
      this.#turnActivityLineIndices.length = 0;
      this.#streamingAssistantText = "";
      this.#streamingAssistantLineIndex = undefined;
      await this.#drainInputQueue();
    }
  }

  async #drainInputQueue(): Promise<void> {
    while (this.#inputQueue.length > 0 && !this.#busy) {
      const next = this.#inputQueue.shift();
      if (next === undefined || next.trim().length === 0) continue;
      await this.#runUserPrompt(next.trim());
    }
  }

  async cancel(): Promise<void> {
    if (this.#sessionId === undefined) return;
    this.#clearStreamingAssistant();
    if (this.#userQuestionWaiter !== undefined) {
      this.cancelUserQuestion();
    }
    try {
      await this.#client.cancel(this.#sessionId);
      this.#push("status", "cancelled");
    } catch (err) {
      this.#push("status", `cancel failed: ${(err as Error).message}`);
    }
  }

  #clearStreamingAssistant(): void {
    clearStreamingAssistantImpl(this.#protocolState());
  }

  async listPeers(): Promise<void> {
    return listPeersImpl(this.#sink());
  }

  async refreshCluster(): Promise<ClientClusterStatus | undefined> {
    return refreshClusterImpl(this.#clusterCtx());
  }

  async connectMeshPeer(raw: string): Promise<void> {
    return connectMeshPeerImpl(this.#clusterCtx(), raw);
  }

  async getModelLabel(): Promise<string | undefined> {
    return getModelLabelImpl(this.#sink());
  }

  noteDiscoveryEvent(event: ClientDiscoveryEvent): void {
    noteDiscoveryEventImpl(this.#clusterCtx(), event);
  }

  async subscribeDiscovery(onEvent?: () => void): Promise<() => void> {
    return subscribeDiscoveryImpl(this.#clusterCtx(), onEvent);
  }

  async showRoute(tag: string): Promise<void> {
    return showRouteImpl(this.#sink(), tag);
  }

  async peers(): Promise<ClientPeerInfo[]> {
    return peersImpl(this.#sink());
  }

  async teamJobs(): Promise<ClientTeamJob[]> {
    return teamJobsImpl(this.#sink());
  }

  async scoreboard(): Promise<ClientScoreboardEntry[]> {
    return scoreboardImpl(this.#sink());
  }

  async route(tag: string): Promise<ClientPeerInfo | undefined> {
    return routeImpl(this.#sink(), tag);
  }

  async showSearch(term: string): Promise<void> {
    return showSearchImpl(this.#clusterCtx(), term);
  }

  showTrace(): void {
    showTraceImpl(this.#clusterCtx());
  }

  async showClusterStatus(): Promise<void> {
    return showClusterStatusImpl(this.#sink());
  }

  async showTeamJobs(): Promise<void> {
    return showTeamJobsImpl(this.#sink());
  }

  async showScoreboard(): Promise<void> {
    return showScoreboardImpl(this.#sink());
  }

  close(): void {
    this.#removeSessionUpdate();
    this.#removeSessionToken();
    this.#removeSessionActivity();
    this.#client.close();
  }

  async showTools(): Promise<void> {
    return showToolsImpl(this.#sink());
  }

  async showConfig(): Promise<void> {
    return showConfigImpl(this.#sink());
  }

  showSessionInfo(): void {
    showSessionInfoImpl(this.#workspaceCtx());
  }

  async showStatus(): Promise<void> {
    return showStatusImpl(this.#workspaceCtx(), () => this.getModelLabel());
  }

  showCost(): void {
    showCostImpl(this.#workspaceCtx());
  }

  clearTranscript(): void {
    clearTranscriptImpl(this.#workspaceCtx());
  }

  async newSession(): Promise<void> {
    return newSessionImpl(this.#workspaceCtx());
  }

  showContext(): void {
    showContextImpl(this.#workspaceCtx());
  }

  showModelUsage(): void {
    showModelUsageImpl(this.#sink());
  }

  async runCompact(
    keep?: number,
    budget?: number,
    summarize?: boolean,
  ): Promise<void> {
    return runCompactImpl(this.#sink(), keep, budget, summarize);
  }

  async runSetProvider(name: string, model?: string): Promise<void> {
    return runSetProviderImpl(this.#sink(), name, model);
  }

  async runSetSandbox(mode: string): Promise<void> {
    return runSetSandboxImpl(this.#sink(), mode);
  }

  async runSetApproval(mode: string): Promise<void> {
    return runSetApprovalImpl(this.#sink(), mode);
  }

  async runSetAutoRun(
    mode: "safe-only" | "always-confirm" | "off" | undefined,
  ): Promise<void> {
    return runSetAutoRunImpl(this.#sink(), mode);
  }

  async showGitDiff(staged?: boolean, stat?: boolean): Promise<void> {
    return showGitDiffImpl(this.#sink(), staged, stat);
  }

  async showGitStatus(): Promise<void> {
    return showGitStatusImpl(this.#sink());
  }

  async showHooks(): Promise<void> {
    return showHooksImpl(this.#sink());
  }

  async showMcp(): Promise<void> {
    return showMcpImpl(this.#sink());
  }

  async showAgents(): Promise<void> {
    return showAgentsImpl(this.#sink());
  }

  async runMemory(
    op: "list" | "read" | "add",
    name?: string,
    body?: string,
  ): Promise<void> {
    return runMemoryImpl(this.#sink(), op, name, body);
  }

  async runPlan(
    action: string,
    text?: string,
    reason?: string,
  ): Promise<void> {
    return runPlanImpl(this.#sink(), action, text, reason);
  }

  async runMode(mode?: "default" | "plan" | "review"): Promise<void> {
    return runModeImpl(this.#sink(), mode);
  }

  async runReview(staged?: boolean): Promise<void> {
    return runReviewImpl(this.#sink(), staged);
  }

  async runInit(): Promise<void> {
    return runInitImpl(this.#sink());
  }

  async resumeSession(sessionId: string): Promise<void> {
    return resumeSessionImpl(this.#workspaceCtx(), sessionId);
  }

  async listPersistedSessions(): Promise<
    Awaited<ReturnType<EnvoyHarnessClient["listSessions"]>>
  > {
    return listPersistedSessionsImpl(this.#client);
  }

  async fetchPlanView(): Promise<string> {
    return fetchPlanViewImpl(this.#sink());
  }

  async fetchMemoryView(): Promise<string> {
    return fetchMemoryViewImpl(this.#sink());
  }

  async fetchGitDiffView(staged?: boolean, stat?: boolean): Promise<string> {
    if (staged !== undefined || stat !== undefined) {
      setGitDiffFlagsImpl(this.#workspaceCtx(), staged, stat);
    }
    return fetchGitDiffViewImpl(this.#workspaceCtx());
  }

  setGitDiffFlags(staged?: boolean, stat?: boolean): void {
    setGitDiffFlagsImpl(this.#workspaceCtx(), staged, stat);
  }

  #handleSessionActivity(params: unknown): void {
    handleSessionActivityImpl(
      this.#protocolState(),
      params,
      (activity) => this.#pushActivity(activity),
    );
  }

  #pushActivity(activity: ActivityLike): void {
    pushActivityImpl(
      this.#protocolState(),
      (role, text) => this.#push(role, text),
      activity,
    );
  }

  #handleSessionToken(params: unknown): void {
    handleSessionTokenImpl(this.#protocolState(), params);
  }

  #handleSessionUpdate(params: unknown): void {
    handleSessionUpdateImpl(
      this.#protocolState(),
      params,
      (msg) => this.#consumeProtocolMessage(msg),
    );
  }

  #consumeProtocolMessage(msg: unknown): void {
    consumeProtocolMessageImpl(
      this.#protocolState(),
      (role, text) => this.#push(role, text),
      msg,
    );
  }

  renderTranscript(): string {
    return this.#lines
      .map((line) => formatTranscriptLine(line, this.#transcriptFormat))
      .join("\n");
  }

  #push(role: TranscriptRole, text: string): void {
    this.#lines.push({
      role,
      text,
      at: new Date().toISOString(),
    });
    this.#onTranscript?.(this.#lines);
  }
}
