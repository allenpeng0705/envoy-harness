/**
 * TuiSession — ACP-backed controller (IO-free for hermetic tests).
 */

import type { EnvoyHarnessClient } from "@envoymesh/envoy-harness-client";

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
