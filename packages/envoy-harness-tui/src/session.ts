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
import {
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
  readonly #onTranscript:
    | ((lines: readonly TranscriptLine[]) => void)
    | undefined;
  readonly #onPermission:
    | ((req: PermissionRequest) => Promise<"allow" | "deny">)
    | undefined;
  readonly #lines: TranscriptLine[] = [];
  #sessionId: string | undefined;
  #busy = false;
  #clusterSnapshot: ClientClusterStatus | undefined;
  readonly #discoveryEvents: ClientDiscoveryEvent[] = [];
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

  /** Used by EnvoyHarnessClient.onPermissionRequest. */
  handlePermissionRequest(
    req: PermissionRequest,
  ): Promise<"allow" | "deny"> {
    if (this.#onPermission !== undefined) {
      return this.#onPermission(req);
    }
    return new Promise<"allow" | "deny">((resolve) => {
      this.#permissionWaiter = { req, resolve };
      this.#push(
        "status",
        `permission: allow ${req.toolName}? (${req.description}) — type allow/deny`,
      );
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
    try {
      const result = await this.#client.prompt(this.#sessionId, trimmed);
      for (const msg of result.messages) {
        const m = msg as { role?: string; text?: string };
        if (typeof m.text !== "string" || m.text.length === 0) continue;
        const role = (m.role as TranscriptRole | undefined) ?? "assistant";
        if (role === "user") continue;
        this.#push(role === "assistant" ? "assistant" : role, m.text);
      }
      this.#push("status", `stop: ${result.stopReason}`);
    } catch (err) {
      this.#push("status", `error: ${(err as Error).message}`);
    } finally {
      this.#busy = false;
    }
    return "ok";
  }

  async cancel(): Promise<void> {
    if (this.#sessionId === undefined) return;
    try {
      await this.#client.cancel(this.#sessionId);
      this.#push("status", "cancelled");
    } catch (err) {
      this.#push("status", `cancel failed: ${(err as Error).message}`);
    }
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
    this.#client.close();
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
