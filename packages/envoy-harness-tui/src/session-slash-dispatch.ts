/**
 * Slash command dispatch — extracted from TuiSession.submit.
 */

import type { SlashResult } from "./slash.js";
import type { PushFn } from "./session-context.js";

/** Public TuiSession surface needed for slash routing. */
export interface SlashSessionHost {
  cancel(): Promise<void>;
  connectMeshPeer(raw: string): Promise<void>;
  listPeers(): Promise<void>;
  showClusterStatus(): Promise<void>;
  showTeamJobs(): Promise<void>;
  showScoreboard(): Promise<void>;
  showRoute(tag: string): Promise<void>;
  showSearch(term: string): Promise<void>;
  showTrace(): void;
  showTools(): Promise<void>;
  showConfig(): Promise<void>;
  showSessionInfo(): void;
  showStatus(): Promise<void>;
  showCost(): void;
  clearTranscript(): void;
  newSession(): Promise<void>;
  showContext(): void;
  runCompact(keep?: number, budget?: number, summarize?: boolean): Promise<void>;
  runSetProvider(name: string, model?: string): Promise<void>;
  showModelUsage(): void;
  runSetSandbox(mode: string): Promise<void>;
  runSetApproval(mode: string): Promise<void>;
  runSetAutoRun(
    mode: "safe-only" | "always-confirm" | "off" | undefined,
  ): Promise<void>;
  showGitDiff(staged?: boolean, stat?: boolean): Promise<void>;
  showGitStatus(): Promise<void>;
  showHooks(): Promise<void>;
  showMcp(): Promise<void>;
  showAgents(): Promise<void>;
  runMemory(
    op: "list" | "read" | "add",
    name?: string,
    body?: string,
  ): Promise<void>;
  runPlan(action: string, text?: string, reason?: string): Promise<void>;
  runMode(mode?: "default" | "plan" | "review"): Promise<void>;
  runReview(staged?: boolean): Promise<void>;
  runInit(): Promise<void>;
  resumeSession(sessionId: string): Promise<void>;
}

export async function dispatchSlashImpl(
  push: PushFn,
  session: SlashSessionHost,
  slash: SlashResult,
): Promise<"ok" | "quit"> {
  switch (slash.kind) {
    case "help":
      push("status", slash.text.trimEnd());
      return "ok";
    case "cancel":
      await session.cancel();
      return "ok";
    case "mesh":
      if (slash.action === "connect" && slash.endpoint !== undefined) {
        await session.connectMeshPeer(slash.endpoint);
      }
      return "ok";
    case "peers":
      await session.listPeers();
      return "ok";
    case "cluster":
      await session.showClusterStatus();
      return "ok";
    case "team":
      await session.showTeamJobs();
      return "ok";
    case "scoreboard":
      await session.showScoreboard();
      return "ok";
    case "route":
      await session.showRoute(slash.tag);
      return "ok";
    case "search":
      await session.showSearch(slash.term);
      return "ok";
    case "trace":
      session.showTrace();
      return "ok";
    case "tools":
      await session.showTools();
      return "ok";
    case "config":
      await session.showConfig();
      return "ok";
    case "session":
      session.showSessionInfo();
      return "ok";
    case "status":
      await session.showStatus();
      return "ok";
    case "cost":
      session.showCost();
      return "ok";
    case "clear":
      session.clearTranscript();
      return "ok";
    case "new":
      await session.newSession();
      return "ok";
    case "context":
      session.showContext();
      return "ok";
    case "compact":
      await session.runCompact(slash.keep, slash.budget, slash.summarize);
      return "ok";
    case "provider":
      await session.runSetProvider(slash.name, slash.model);
      return "ok";
    case "model":
      session.showModelUsage();
      return "ok";
    case "sandbox":
      await session.runSetSandbox(slash.mode);
      return "ok";
    case "approval":
      await session.runSetApproval(slash.mode);
      return "ok";
    case "permissions":
      await session.runSetAutoRun(slash.mode);
      return "ok";
    case "diff":
      await session.showGitDiff(slash.staged, slash.stat);
      return "ok";
    case "git-status":
      await session.showGitStatus();
      return "ok";
    case "hooks":
      await session.showHooks();
      return "ok";
    case "mcp":
      await session.showMcp();
      return "ok";
    case "agents":
      await session.showAgents();
      return "ok";
    case "memory":
      await session.runMemory(slash.op, slash.name, slash.body);
      return "ok";
    case "plan":
      await session.runPlan(slash.action, slash.text, slash.reason);
      return "ok";
    case "mode":
      await session.runMode(slash.mode);
      return "ok";
    case "review":
      await session.runReview(slash.staged);
      return "ok";
    case "init":
      await session.runInit();
      return "ok";
    case "resume":
      if (slash.id !== undefined && slash.id.length > 0) {
        await session.resumeSession(slash.id);
      }
      return "ok";
    case "quit":
      return "quit";
    case "unknown":
      push(
        "status",
        `unknown slash: /${slash.command} — try /help`,
      );
      return "ok";
  }
}
