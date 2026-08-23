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

import { parseSlash } from "./slash.js";
import { formatActivityLine, type ActivityLike } from "./activity.js";
import { buildPermissionPreview } from "./permission-preview.js";
import {
  formatPermissionBlock,
  formatTranscriptLine,
  type TranscriptLine,
  type TranscriptRole,
} from "./transcript.js";

export interface PermissionRequest {
  sessionId: string;
  toolName: string;
  description: string;
  args: unknown;
}

export interface TuiSessionOptions {
  client: EnvoyHarnessClient;
  cwd?: string;
  onTranscript?: (lines: readonly TranscriptLine[]) => void;
  onPermission?: (req: PermissionRequest) => Promise<"allow" | "deny">;
}

export class TuiSession {
  readonly #client: EnvoyHarnessClient;
  readonly #cwd: string | undefined;
  #onTranscript: ((lines: readonly TranscriptLine[]) => void) | undefined;
  readonly #onPermission:
    | ((req: PermissionRequest) => Promise<"allow" | "deny">)
    | undefined;
  readonly #lines: TranscriptLine[] = [];
  #sessionId: string | undefined;
  #busy = false;
  /** Dedupe live `session/update` vs final `session/prompt` messages. */
  readonly #turnSeen = new Set<string>();
  /** Tool lines shown via activity this turn — skip duplicate tool transcript. */
  #turnToolActivityLines = 0;
  /** Status line indices to collapse when the turn ends. */
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
  #permissionWaiter:
    | {
        req: PermissionRequest;
        resolve: (d: "allow" | "deny") => void;
      }
    | undefined;

  constructor(options: TuiSessionOptions) {
    this.#client = options.client;
    this.#cwd = options.cwd;
    this.#onTranscript = options.onTranscript;
    this.#onPermission = options.onPermission;
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

  /** Wire live transcript refresh (screen / plain mode). */
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

  get transcript(): readonly TranscriptLine[] {
    return this.#lines;
  }

  get pendingPermission(): PermissionRequest | undefined {
    return this.#permissionWaiter?.req;
  }

  /** The last cluster snapshot (U2 cluster rail). */
  get clusterSnapshot(): ClientClusterStatus | undefined {
    return this.#clusterSnapshot;
  }

  /** U3/U5 — recent discovery events (newest last, max 20; /trace reads it). */
  get discoveryEvents(): readonly ClientDiscoveryEvent[] {
    return [...this.#discoveryEvents];
  }

  get gitDiffStaged(): boolean {
    return this.#gitDiffStaged;
  }

  get gitDiffStat(): boolean {
    return this.#gitDiffStat;
  }

  /** Used by EnvoyHarnessClient.onPermissionRequest. */
  handlePermissionRequest(
    req: PermissionRequest,
  ): Promise<"allow" | "deny"> {
    if (this.#onPermission !== undefined) {
      return this.#onPermission(req);
    }
    return new Promise<"allow" | "deny">((resolve) => {
      this.#permissionWaiter = { req, resolve };
      this.#push("status", formatPermissionBlock(req));
      void buildPermissionPreview(req, this.#cwd).then((preview) => {
        if (preview !== undefined && preview.trim().length > 0) {
          this.#push("status", formatPermissionBlock(req, preview));
        }
      });
    });
  }

  answerPermission(decision: "allow" | "deny"): boolean {
    if (this.#permissionWaiter === undefined) return false;
    this.#permissionWaiter.resolve(decision);
    this.#permissionWaiter = undefined;
    this.#push("status", `permission → ${decision}`);
    return true;
  }

  async start(): Promise<void> {
    const init = await this.#client.initialize();
    this.#push(
      "status",
      `ACP protocol v${init.protocolVersion} — /help for commands`,
    );
    const created = await this.#client.acpNewSession(
      this.#cwd !== undefined ? { cwd: this.#cwd } : undefined,
    );
    this.#sessionId = created.sessionId;
    this.#push("system", `session ${created.sessionId}`);
  }

  async submit(line: string): Promise<"ok" | "quit"> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return "ok";

    const slash = parseSlash(trimmed);
    if (slash !== null) {
      switch (slash.kind) {
        case "help":
          this.#push("status", slash.text.trimEnd());
          return "ok";
        case "cancel":
          await this.cancel();
          return "ok";
        case "mesh":
          if (slash.action === "connect" && slash.endpoint !== undefined) {
            await this.connectMeshPeer(slash.endpoint);
          }
          return "ok";
        case "peers":
          await this.listPeers();
          return "ok";
        case "cluster":
          await this.showClusterStatus();
          return "ok";
        case "team":
          await this.showTeamJobs();
          return "ok";
        case "scoreboard":
          await this.showScoreboard();
          return "ok";
        case "route":
          await this.showRoute(slash.tag);
          return "ok";
        case "search":
          await this.showSearch(slash.term);
          return "ok";
        case "trace":
          this.showTrace();
          return "ok";
        case "tools":
          await this.showTools();
          return "ok";
        case "config":
          await this.showConfig();
          return "ok";
        case "session":
          this.showSessionInfo();
          return "ok";
        case "status":
          await this.showStatus();
          return "ok";
        case "cost":
          this.showCost();
          return "ok";
        case "clear":
          this.clearTranscript();
          return "ok";
        case "new":
          await this.newSession();
          return "ok";
        case "context":
          this.showContext();
          return "ok";
        case "compact":
          await this.runCompact(slash.keep, slash.budget, slash.summarize);
          return "ok";
        case "provider":
          await this.runSetProvider(slash.name, slash.model);
          return "ok";
        case "model":
          this.showModelUsage();
          return "ok";
        case "sandbox":
          await this.runSetSandbox(slash.mode);
          return "ok";
        case "approval":
          await this.runSetApproval(slash.mode);
          return "ok";
        case "diff":
          await this.showGitDiff(slash.staged, slash.stat);
          return "ok";
        case "git-status":
          await this.showGitStatus();
          return "ok";
        case "hooks":
          await this.showHooks();
          return "ok";
        case "mcp":
          await this.showMcp();
          return "ok";
        case "agents":
          await this.showAgents();
          return "ok";
        case "memory":
          await this.runMemory(slash.op, slash.name, slash.body);
          return "ok";
        case "plan":
          await this.runPlan(slash.action, slash.text, slash.reason);
          return "ok";
        case "review":
          await this.runReview(slash.staged);
          return "ok";
        case "init":
          await this.runInit();
          return "ok";
        case "resume":
          await this.resumeSession(slash.id);
          return "ok";
        case "quit":
          return "quit";
        case "unknown":
          this.#push(
            "status",
            `unknown slash: /${slash.command} — try /help`,
          );
          return "ok";
      }
    }

    if (this.#sessionId === undefined) {
      this.#push("status", "not started — call start() first");
      return "ok";
    }
    if (this.#busy) {
      this.#push("status", "busy — /cancel to abort");
      return "ok";
    }

    this.#push("user", trimmed);
    this.#busy = true;
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
      this.#push("status", `stop: ${result.stopReason}`);
    } catch (err) {
      this.#push("status", `error: ${(err as Error).message}`);
    } finally {
      this.#busy = false;
      this.#turnToolActivityLines = 0;
      this.#turnActivityLineIndices.length = 0;
      this.#streamingAssistantText = "";
      this.#streamingAssistantLineIndex = undefined;
    }
    return "ok";
  }

  async cancel(): Promise<void> {
    if (this.#sessionId === undefined) return;
    this.#clearStreamingAssistant();
    try {
      await this.#client.cancel(this.#sessionId);
      this.#push("status", "cancelled");
    } catch (err) {
      this.#push("status", `cancel failed: ${(err as Error).message}`);
    }
  }

  /** Drop or finalize the in-flight assistant stream line on cancel. */
  #clearStreamingAssistant(): void {
    if (this.#streamingAssistantLineIndex === undefined) {
      this.#streamingAssistantText = "";
      return;
    }
    const line = this.#lines[this.#streamingAssistantLineIndex];
    if (line === undefined) {
      this.#streamingAssistantText = "";
      this.#streamingAssistantLineIndex = undefined;
      return;
    }
    line.text =
      line.text.length > 0 ? `${line.text} [cancelled]` : "(cancelled)";
    this.#streamingAssistantText = "";
    this.#streamingAssistantLineIndex = undefined;
    this.#onTranscript?.(this.#lines);
  }

  /** R3 — render the host's connected peer cluster (`peers/list`). */
  async listPeers(): Promise<void> {
    let peers;
    try {
      peers = await this.#client.listPeers();
    } catch (err) {
      this.#push("status", `peers unavailable: ${(err as Error).message}`);
      return;
    }
    if (peers.length === 0) {
      this.#push("status", "Peers (0) — no peers connected");
      return;
    }
    const lines = peers.map((p) => {
      const model = p.model !== undefined ? ` model=${p.model}` : "";
      const caps =
        p.capabilities !== undefined && p.capabilities.length > 0
          ? ` capabilities=${p.capabilities.join(",")}`
          : "";
      return `- ${p.id}${model}${caps}`;
    });
    this.#push("status", `Peers (${peers.length})\n${lines.join("\n")}`);
  }

  /** U2 — refresh the cluster snapshot (`cluster/status`); best-effort. */
  async refreshCluster(): Promise<ClientClusterStatus | undefined> {
    try {
      this.#clusterSnapshot = await this.#client.clusterStatus();
    } catch {
      // Keep the previous snapshot (or undefined); the UI shows the rail
      // only when a snapshot exists.
    }
    return this.#clusterSnapshot;
  }

  /** U2 — the host's model label from `config/get` (best-effort). */
  async getModelLabel(): Promise<string | undefined> {
    try {
      const config = await this.#client.getConfig();
      const model = (config as { model?: unknown }).model;
      return typeof model === "string" && model.length > 0 ? model : undefined;
    } catch {
      return undefined;
    }
  }

  /** U3 — buffer one discovery event (the UI renders it as a ticker). */
  noteDiscoveryEvent(event: ClientDiscoveryEvent): void {
    this.#discoveryEvents.push(event);
    if (this.#discoveryEvents.length > 20) {
      this.#discoveryEvents.splice(0, this.#discoveryEvents.length - 20);
    }
  }

  /** U3 — subscribe to the host's discovery stream; returns unsubscribe. */
  async subscribeDiscovery(onEvent?: () => void): Promise<() => void> {
    const remove = await this.#client.subscribeDiscovery((event) => {
      this.noteDiscoveryEvent(event);
      onEvent?.();
    });
    return remove;
  }

  /** U3 — routing preview (plain mode renders it as a status line). */
  async showRoute(tag: string): Promise<void> {
    let peer;
    try {
      peer = await this.#client.routePeer(tag);
    } catch (err) {
      this.#push("status", `route unavailable: ${(err as Error).message}`);
      return;
    }
    if (peer === undefined) {
      this.#push("status", `Route "${tag}" → no peer available`);
      return;
    }
    const model = peer.model !== undefined ? ` model=${peer.model}` : "";
    const caps =
      peer.capabilities !== undefined && peer.capabilities.length > 0
        ? ` capabilities=${peer.capabilities.join(",")}`
        : "";
    this.#push("status", `Route "${tag}" → ${peer.id}${model}${caps}`);
  }

  /** U3 — raw peer list for the view renderer. */
  async peers(): Promise<ClientPeerInfo[]> {
    return this.#client.listPeers();
  }

  /** U3 — raw team jobs for the view renderer. */
  async teamJobs(): Promise<ClientTeamJob[]> {
    return this.#client.teamJobs();
  }

  /** U3 — raw scoreboard entries for the view renderer. */
  async scoreboard(): Promise<ClientScoreboardEntry[]> {
    return this.#client.scoreboardSummary();
  }

  /** U3 — raw routing preview for the view renderer. */
  async route(tag: string): Promise<ClientPeerInfo | undefined> {
    return this.#client.routePeer(tag);
  }

  /** U5 — plain-mode `/search`: list matching transcript lines. */
  async showSearch(term: string): Promise<void> {
    const matches = this.#lines
      .map(formatTranscriptLine)
      .filter((line) => line.toLowerCase().includes(term.toLowerCase()));
    if (matches.length === 0) {
      this.#push("status", `Search "${term}" — no matches`);
      return;
    }
    this.#push(
      "status",
      `Search "${term}" — ${matches.length} match${matches.length === 1 ? "" : "es"}\n${matches.map((m) => `  ${m}`).join("\n")}`,
    );
  }

  /** U5 — plain-mode `/trace`: the discovery event log. */
  showTrace(): void {
    if (this.#discoveryEvents.length === 0) {
      this.#push("status", "Trace (0) — no events yet");
      return;
    }
    this.#push(
      "status",
      `Trace (${this.#discoveryEvents.length})\n${[...this.#discoveryEvents]
        .reverse()
        .map((e) => `  ${e.at} ${e.peerId} ${e.type}`)
        .join("\n")}`,
    );
  }

  /** U1 — render the host's cluster status (`cluster/status`). */
  async showClusterStatus(): Promise<void> {
    let cluster;
    try {
      cluster = await this.#client.clusterStatus();
    } catch (err) {
      this.#push("status", `cluster unavailable: ${(err as Error).message}`);
      return;
    }
    if (cluster.peers.length === 0) {
      this.#push(
        "status",
        `Cluster (0) — no peers connected (${cluster.connected}/${cluster.failed})`,
      );
      return;
    }
    const lines = cluster.peers.map((p) => {
      const model = p.model !== undefined ? ` model=${p.model}` : "";
      const caps =
        p.capabilities !== undefined && p.capabilities.length > 0
          ? ` capabilities=${p.capabilities.join(",")}`
          : "";
      const health = p.health.ok
        ? ` ok${p.health.rttMs !== undefined ? ` rtt=${p.health.rttMs}ms` : ""}`
        : ` down${p.health.error !== undefined ? ` (${p.health.error})` : ""}`;
      return `- ${p.id}${model}${caps}${health}`;
    });
    this.#push(
      "status",
      `Cluster (${cluster.peers.length} connected=${cluster.connected} failed=${cluster.failed})\n${lines.join("\n")}`,
    );
  }

  /** U1 — render the host's team jobs (`team/jobs`). */
  async showTeamJobs(): Promise<void> {
    let jobs;
    try {
      jobs = await this.#client.teamJobs();
    } catch (err) {
      this.#push("status", `team unavailable: ${(err as Error).message}`);
      return;
    }
    if (jobs.length === 0) {
      this.#push("status", "Team (0) — no jobs");
      return;
    }
    const lines = jobs.map((j) => {
      const cost = j.costUsd !== undefined ? ` cost=${j.costUsd}` : "";
      const agents = j.agents
        .map((a) => `${a.id}@${a.host}=${a.status}`)
        .join(", ");
      return `- ${j.jobId} ${j.status}${cost}\n    ${agents}`;
    });
    this.#push("status", `Team (${jobs.length})\n${lines.join("\n")}`);
  }

  /** U1 — render the host's peer reputation scoreboard (`scoreboard/summary`). */
  async showScoreboard(): Promise<void> {
    let entries;
    try {
      entries = await this.#client.scoreboardSummary();
    } catch (err) {
      this.#push("status", `scoreboard unavailable: ${(err as Error).message}`);
      return;
    }
    if (entries.length === 0) {
      this.#push("status", "Scoreboard (0) — no verdicts yet");
      return;
    }
    const lines = entries.map(
      (e) =>
        `- ${e.workerPeerId} ${e.skillId} score=${e.score} pass=${e.passCount} fail=${e.failCount} partial=${e.partialCount}`,
    );
    this.#push("status", `Scoreboard (${entries.length})\n${lines.join("\n")}`);
  }

  close(): void {
    this.#removeSessionUpdate();
    this.#removeSessionToken();
    this.#removeSessionActivity();
    this.#client.close();
  }

  /** R3 — list tools (`tools/list`). */
  async showTools(): Promise<void> {
    let tools;
    try {
      tools = await this.#client.listTools();
    } catch (err) {
      this.#push("status", `tools unavailable: ${(err as Error).message}`);
      return;
    }
    if (tools.length === 0) {
      this.#push("status", "Tools (0)");
      return;
    }
    const lines = tools.map((t) => `- ${t.name}: ${t.description}`);
    this.#push("status", `Tools (${tools.length})\n${lines.join("\n")}`);
  }

  /** Show harness config (`config/get`). */
  async showConfig(): Promise<void> {
    try {
      const config = await this.#client.getConfig();
      const lines = Object.entries(config).map(([k, v]) => `- ${k}: ${String(v)}`);
      this.#push(
        "status",
        lines.length > 0 ? `Config\n${lines.join("\n")}` : "Config (empty)",
      );
    } catch (err) {
      this.#push("status", `config unavailable: ${(err as Error).message}`);
    }
  }

  showSessionInfo(): void {
    if (this.#sessionId === undefined) {
      this.#push("status", "no active session");
      return;
    }
    this.#push(
      "status",
      `Session ${this.#sessionId}\n  messages: ${this.#lines.length}\n  busy: ${this.#busy}`,
    );
  }

  async showStatus(): Promise<void> {
    const model = await this.getModelLabel();
    const parts = [
      `session: ${this.#sessionId ?? "—"}`,
      `busy: ${this.#busy}`,
      `transcript lines: ${this.#lines.length}`,
      ...(model !== undefined ? [`model: ${model}`] : []),
      ...(this.#lastTurnCostUsd !== undefined
        ? [`last turn cost: $${this.#lastTurnCostUsd.toFixed(4)}`]
        : []),
    ];
    this.#push("status", `Status\n  ${parts.join("\n  ")}`);
  }

  showCost(): void {
    if (this.#lastTurnCostUsd === undefined) {
      this.#push("status", "Cost — no completed turn yet (run a prompt first)");
      return;
    }
    this.#push("status", `Last turn cost: $${this.#lastTurnCostUsd.toFixed(4)}`);
  }

  clearTranscript(): void {
    this.#lines.length = 0;
    this.#onTranscript?.(this.#lines);
    this.#push("status", "transcript cleared (agent session unchanged)");
  }

  /** New ACP session — fresh agent context on the host. */
  async newSession(): Promise<void> {
    if (this.#busy) {
      this.#push("status", "busy — /cancel first, then /new");
      return;
    }
    try {
      const created = await this.#client.acpNewSession(
        this.#cwd !== undefined ? { cwd: this.#cwd } : undefined,
      );
      this.#sessionId = created.sessionId;
      this.#lines.length = 0;
      this.#turnSeen.clear();
      this.#lastTurnCostUsd = undefined;
      this.#onTranscript?.(this.#lines);
      this.#push("system", `new session ${created.sessionId}`);
    } catch (err) {
      this.#push("status", `new session failed: ${(err as Error).message}`);
    }
  }

  /** Transcript footprint (display only — agent memory unchanged). */
  showContext(): void {
    const byRole = new Map<string, number>();
    for (const line of this.#lines) {
      byRole.set(line.role, (byRole.get(line.role) ?? 0) + 1);
    }
    const parts = [
      `session: ${this.#sessionId ?? "—"}`,
      `transcript lines: ${this.#lines.length}`,
      ...[...byRole.entries()].map(([role, n]) => `${role}: ${n}`),
      ...(this.#lastTurnCostUsd !== undefined
        ? [`last turn cost: $${this.#lastTurnCostUsd.toFixed(4)}`]
        : []),
    ];
    this.#push("status", `Context\n  ${parts.join("\n  ")}`);
  }

  showModelUsage(): void {
    this.#push(
      "status",
      "Model swap: use /provider <openai|anthropic|deepseek|ollama> [model-id]\n" +
        "Example: /provider deepseek deepseek-chat",
    );
  }

  async runCompact(
    keep?: number,
    budget?: number,
    summarize?: boolean,
  ): Promise<void> {
    if (this.#sessionId === undefined) {
      this.#push("status", "no active session");
      return;
    }
    if (this.#busy) {
      this.#push("status", "busy — /cancel first");
      return;
    }
    if (summarize === true) {
      this.#push("status", "summarizing transcript…");
    }
    try {
      const r = await this.#client.compactSession(this.#sessionId, {
        ...(keep !== undefined ? { keep } : {}),
        ...(budget !== undefined ? { budget } : {}),
        ...(summarize === true ? { summarize: true } : {}),
      });
      const note =
        r.overBudget === true
          ? " (over budget)"
          : r.summarized === false && summarize === true
            ? " (summarize failed — drop-oldest fallback)"
            : r.summarized === true
              ? " (with LLM summary)"
              : "";
      const tokens =
        r.totalTokensAfter !== undefined
          ? `, ${r.totalTokensAfter} tokens`
          : "";
      this.#push(
        "status",
        `Compacted: ${r.messageCountBefore} → ${r.messageCountAfter} messages (dropped ${r.droppedCount}${tokens})${note}`,
      );
    } catch (err) {
      this.#push("status", `compact failed: ${(err as Error).message}`);
    }
  }

  async runSetProvider(name: string, model?: string): Promise<void> {
    if (this.#sessionId === undefined) {
      this.#push("status", "no active session");
      return;
    }
    if (this.#busy) {
      this.#push("status", "busy — /cancel first");
      return;
    }
    try {
      const r = await this.#client.setSessionModel(
        this.#sessionId,
        name,
        model,
      );
      this.#push(
        "status",
        `provider: ${r.provider}${r.model !== undefined ? ` model=${r.model}` : ""}`,
      );
    } catch (err) {
      this.#push("status", `provider swap failed: ${(err as Error).message}`);
    }
  }

  async runSetSandbox(mode: string): Promise<void> {
    const valid = new Set([
      "read-only",
      "workspace-write",
      "danger-full-access",
    ]);
    if (!valid.has(mode)) {
      this.#push("status", `invalid sandbox: ${mode}`);
      return;
    }
    if (this.#sessionId === undefined) {
      this.#push("status", "no active session");
      return;
    }
    if (this.#busy) {
      this.#push("status", "busy — /cancel first");
      return;
    }
    try {
      await this.#client.setSessionPolicy(this.#sessionId, {
        sandbox: mode as "read-only" | "workspace-write" | "danger-full-access",
      });
      this.#push("status", `sandbox: ${mode}`);
    } catch (err) {
      this.#push("status", `sandbox failed: ${(err as Error).message}`);
    }
  }

  async runSetApproval(mode: string): Promise<void> {
    const valid = new Set([
      "unless-trusted",
      "on-request",
      "granular",
      "never",
    ]);
    if (!valid.has(mode)) {
      this.#push("status", `invalid approval: ${mode}`);
      return;
    }
    if (this.#sessionId === undefined) {
      this.#push("status", "no active session");
      return;
    }
    if (this.#busy) {
      this.#push("status", "busy — /cancel first");
      return;
    }
    try {
      await this.#client.setSessionPolicy(this.#sessionId, {
        approval: mode as "unless-trusted" | "on-request" | "granular" | "never",
      });
      this.#push("status", `approval: ${mode}`);
    } catch (err) {
      this.#push("status", `approval failed: ${(err as Error).message}`);
    }
  }

  async showGitDiff(staged?: boolean, stat?: boolean): Promise<void> {
    if (this.#sessionId === undefined) {
      this.#push("status", "no active session");
      return;
    }
    try {
      const out = await this.#client.gitDiff(this.#sessionId, {
        ...(staged === true ? { staged: true } : {}),
        ...(stat === true ? { stat: true } : {}),
      });
      this.#push("status", `Git diff\n${out}`);
    } catch (err) {
      this.#push("status", `git diff failed: ${(err as Error).message}`);
    }
  }

  async showGitStatus(): Promise<void> {
    if (this.#sessionId === undefined) {
      this.#push("status", "no active session");
      return;
    }
    try {
      const out = await this.#client.gitStatus(this.#sessionId);
      this.#push("status", `Git status\n${out}`);
    } catch (err) {
      this.#push("status", `git status failed: ${(err as Error).message}`);
    }
  }

  async showHooks(): Promise<void> {
    if (this.#sessionId === undefined) {
      this.#push("status", "no active session");
      return;
    }
    try {
      const hooks = await this.#client.listSessionHooks(this.#sessionId);
      if (hooks.length === 0) {
        this.#push("status", "Hooks (0)");
        return;
      }
      const lines = hooks.map(
        (h) => `  ${h.event.padEnd(20)}  ${h.handlerCount} handler(s)`,
      );
      this.#push("status", `Hooks (${hooks.length})\n${lines.join("\n")}`);
    } catch (err) {
      this.#push("status", `hooks failed: ${(err as Error).message}`);
    }
  }

  async showMcp(): Promise<void> {
    if (this.#sessionId === undefined) {
      this.#push("status", "no active session");
      return;
    }
    try {
      const servers = await this.#client.listSessionMcp(this.#sessionId);
      if (servers.length === 0) {
        this.#push("status", "MCP (0 servers)");
        return;
      }
      this.#push(
        "status",
        `MCP (${servers.length})\n${servers.map((s) => `  - ${s}`).join("\n")}`,
      );
    } catch (err) {
      this.#push("status", `mcp failed: ${(err as Error).message}`);
    }
  }

  async showAgents(): Promise<void> {
    if (this.#sessionId === undefined) {
      this.#push("status", "no active session");
      return;
    }
    try {
      const out = await this.#client.listSessionAgents(this.#sessionId);
      this.#push("status", out);
    } catch (err) {
      this.#push("status", `agents failed: ${(err as Error).message}`);
    }
  }

  async runMemory(
    op: "list" | "read" | "add",
    name?: string,
    body?: string,
  ): Promise<void> {
    if (this.#sessionId === undefined) {
      this.#push("status", "no active session");
      return;
    }
    try {
      const out = await this.#client.sessionMemory(this.#sessionId, op, {
        ...(name !== undefined ? { name } : {}),
        ...(body !== undefined ? { body } : {}),
      });
      this.#push("status", out);
    } catch (err) {
      this.#push("status", `memory failed: ${(err as Error).message}`);
    }
  }

  async runPlan(
    action: string,
    text?: string,
    reason?: string,
  ): Promise<void> {
    if (this.#sessionId === undefined) {
      this.#push("status", "no active session");
      return;
    }
    if (this.#busy && action !== "show") {
      this.#push("status", "busy — /cancel first");
      return;
    }
    try {
      const out = await this.#client.sessionPlan(this.#sessionId, action, {
        ...(text !== undefined ? { text } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
      this.#push("status", out);
    } catch (err) {
      this.#push("status", `plan failed: ${(err as Error).message}`);
    }
  }

  async runReview(staged?: boolean): Promise<void> {
    if (this.#sessionId === undefined) {
      this.#push("status", "no active session");
      return;
    }
    if (this.#busy) {
      this.#push("status", "busy — /cancel first");
      return;
    }
    this.#push("status", "reviewing…");
    try {
      const out = await this.#client.sessionReview(
        this.#sessionId,
        staged === true,
      );
      this.#push("status", `Review\n${out}`);
    } catch (err) {
      this.#push("status", `review failed: ${(err as Error).message}`);
    }
  }

  async runInit(): Promise<void> {
    if (this.#sessionId === undefined) {
      this.#push("status", "no active session");
      return;
    }
    if (this.#busy) {
      this.#push("status", "busy — /cancel first");
      return;
    }
    this.#push("status", "generating AGENTS.md…");
    try {
      const out = await this.#client.sessionInit(this.#sessionId);
      this.#push("status", out);
    } catch (err) {
      this.#push("status", `init failed: ${(err as Error).message}`);
    }
  }

  /** U6 — resume a persisted session (`session/load`). */
  async resumeSession(sessionId: string): Promise<void> {
    if (this.#busy) {
      this.#push("status", "busy — /cancel first");
      return;
    }
    try {
      const loaded = await this.#client.loadSession(
        sessionId,
        this.#cwd,
      );
      this.#sessionId = loaded.sessionId;
      this.#lines.length = 0;
      this.#turnSeen.clear();
      this.#lastTurnCostUsd = undefined;
      this.#onTranscript?.(this.#lines);
      this.#push("system", `resumed session ${loaded.sessionId}`);
    } catch (err) {
      this.#push("status", `resume failed: ${(err as Error).message}`);
    }
  }

  /** U6 — plan tab body. */
  async fetchPlanView(): Promise<string> {
    if (this.#sessionId === undefined) return "";
    return await this.#client.sessionPlan(this.#sessionId, "show");
  }

  /** U6 — memory tab body. */
  async fetchMemoryView(): Promise<string> {
    if (this.#sessionId === undefined) return "";
    return await this.#client.sessionMemory(this.#sessionId, "list");
  }

  /** U6 — git diff tab body. */
  async fetchGitDiffView(staged?: boolean, stat?: boolean): Promise<string> {
    if (this.#sessionId === undefined) return "";
    return await this.#client.gitDiff(this.#sessionId, {
      ...(staged === true ? { staged: true } : {}),
      ...(stat === true ? { stat: true } : {}),
    });
  }

  setGitDiffFlags(staged?: boolean, stat?: boolean): void {
    this.#gitDiffStaged = staged === true;
    this.#gitDiffStat = stat === true;
  }

  #handleSessionActivity(params: unknown): void {
    if (!this.#busy || this.#sessionId === undefined) return;
    const p = params as {
      sessionId?: string;
      activity?: ActivityLike;
    };
    if (p.sessionId !== undefined && p.sessionId !== this.#sessionId) return;
    if (p.activity !== undefined) {
      this.#pushActivity(p.activity);
    }
  }

  #pushActivity(activity: ActivityLike): void {
    if (activity.kind === "agent_end") {
      this.#collapseTurnActivityLines();
    }
    const key =
      activity.kind === "tool_progress"
        ? `${activity.kind}\0${activity.ts ?? ""}\0${activity.summary}`
        : `${activity.kind}\0${activity.summary}\0${activity.ts ?? ""}`;
    if (this.#turnSeen.has(key)) return;
    this.#turnSeen.add(key);
    if (
      activity.kind === "tool_call" ||
      activity.kind === "tool_result" ||
      activity.kind === "tool_progress"
    ) {
      this.#turnToolActivityLines++;
      this.#turnActivityLineIndices.push(this.#lines.length);
    }
    if (activity.kind === "agent_end" && activity.costUsd !== undefined) {
      this.#lastTurnCostUsd = activity.costUsd;
    }
    this.#push("status", formatActivityLine(activity));
  }

  #collapseTurnActivityLines(): void {
    if (this.#turnActivityLineIndices.length === 0) return;
    const sorted = [...this.#turnActivityLineIndices].sort((a, b) => b - a);
    for (const idx of sorted) {
      this.#lines.splice(idx, 1);
      if (
        this.#streamingAssistantLineIndex !== undefined &&
        idx < this.#streamingAssistantLineIndex
      ) {
        this.#streamingAssistantLineIndex -= 1;
      }
    }
    this.#turnActivityLineIndices.length = 0;
    this.#turnToolActivityLines = 0;
    this.#onTranscript?.(this.#lines);
  }

  #handleSessionToken(params: unknown): void {
    if (!this.#busy || this.#sessionId === undefined) return;
    const p = params as {
      sessionId?: string;
      token?: { role?: string; delta?: string };
    };
    if (p.sessionId !== undefined && p.sessionId !== this.#sessionId) return;
    const token = p.token;
    if (token === undefined) return;
    if (
      token.role !== "assistant" ||
      typeof token.delta !== "string" ||
      token.delta.length === 0
    ) {
      return;
    }
    this.#streamingAssistantText += token.delta;
    if (this.#streamingAssistantLineIndex === undefined) {
      this.#lines.push({
        role: "assistant",
        text: this.#streamingAssistantText,
        at: new Date().toISOString(),
      });
      this.#streamingAssistantLineIndex = this.#lines.length - 1;
    } else {
      const streamLine = this.#lines[this.#streamingAssistantLineIndex];
      if (streamLine !== undefined) {
        streamLine.text = this.#streamingAssistantText;
      }
    }
    this.#onTranscript?.(this.#lines);
  }

  #handleSessionUpdate(params: unknown): void {
    if (!this.#busy || this.#sessionId === undefined) return;
    const p = params as {
      sessionId?: string;
      message?: { role?: string; text?: string };
    };
    if (p.sessionId !== undefined && p.sessionId !== this.#sessionId) return;
    this.#consumeProtocolMessage(p.message);
  }

  #consumeProtocolMessage(msg: unknown): void {
    if (msg === undefined || msg === null) return;
    const m = msg as { role?: string; text?: string };
    if (typeof m.text !== "string" || m.text.length === 0) return;
    const rawRole = (m.role as TranscriptRole | undefined) ?? "assistant";
    if (rawRole === "user" || rawRole === "system" || rawRole === "status") {
      return;
    }
    const role: TranscriptRole =
      rawRole === "assistant" || rawRole === "tool" ? rawRole : "assistant";
    if (
      role === "assistant" &&
      this.#streamingAssistantLineIndex !== undefined
    ) {
      const streamLine = this.#lines[this.#streamingAssistantLineIndex];
      if (streamLine !== undefined) {
        streamLine.text = m.text;
      }
      this.#turnSeen.add(`${role}\0${m.text}`);
      this.#streamingAssistantLineIndex = undefined;
      this.#streamingAssistantText = "";
      this.#onTranscript?.(this.#lines);
      return;
    }
    if (
      role === "tool" &&
      this.#busy &&
      this.#turnToolActivityLines > 0
    ) {
      return;
    }
    const key = `${role}\0${m.text}`;
    if (this.#turnSeen.has(key)) return;
    this.#turnSeen.add(key);
    this.#push(role, m.text);
  }

  renderTranscript(): string {
    return this.#lines.map(formatTranscriptLine).join("\n");
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
