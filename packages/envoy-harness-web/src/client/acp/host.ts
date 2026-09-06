/**
 * High-level ACP host over the browser WebSocket JSON-RPC client.
 */

import {
  connectAcpWs,
  type WsJsonRpcClient,
} from "./ws-jsonrpc.js";

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  at: number;
}

export interface PermissionPrompt {
  sessionId: string;
  toolName: string;
  description: string;
  args: unknown;
  resolve: (decision: "allow" | "deny") => void;
}

export interface UserQuestionPrompt {
  sessionId: string;
  question: string;
  options?: string[];
  resolve: (answer: {
    value: string;
    optionIndex?: number;
    cancelled?: boolean;
  }) => void;
}

export interface SessionSummary {
  id: string;
  mtimeMs: number;
  title?: string;
  cwd?: string;
  startedAt?: string;
  messageCount: number;
}

export interface AcpHostState {
  ready: boolean;
  busy: boolean;
  sessionId: string | null;
  protocolVersion: number | null;
  model: string;
  provider: string;
  sandbox: string;
  approval: string;
  autoRun: string;
  peerCount: number;
  cwd: string;
  messages: ChatMessage[];
  error: string | null;
  permission: PermissionPrompt | null;
  userQuestion: UserQuestionPrompt | null;
}

type Listener = () => void;

let msgSeq = 0;
function nextMsgId(): string {
  msgSeq += 1;
  return `m${msgSeq}`;
}

export class AcpHost {
  #client: WsJsonRpcClient | undefined;
  #listeners = new Set<Listener>();
  #state: AcpHostState = {
    ready: false,
    busy: false,
    sessionId: null,
    protocolVersion: null,
    model: "",
    provider: "",
    sandbox: "read-only",
    approval: "on-request",
    autoRun: "always-confirm",
    peerCount: 0,
    cwd: "",
    messages: [],
    error: null,
    permission: null,
    userQuestion: null,
  };

  get state(): AcpHostState {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const l of [...this.#listeners]) l();
  }

  #patch(partial: Partial<AcpHostState>): void {
    this.#state = { ...this.#state, ...partial };
    this.#emit();
  }

  #pushMessage(role: ChatRole, text: string): void {
    this.#patch({
      messages: [
        ...this.#state.messages,
        { id: nextMsgId(), role, text, at: Date.now() },
      ],
    });
  }

  async connect(): Promise<void> {
    try {
      const client = await connectAcpWs();
      this.#client = client;

      client.onRequest(async (method, params) => {
        if (method === "session/request_permission") {
          const req = params as {
            sessionId: string;
            toolName: string;
            description: string;
            args: unknown;
          };
          const decision = await new Promise<"allow" | "deny">((resolve) => {
            this.#patch({
              permission: {
                sessionId: req.sessionId,
                toolName: req.toolName,
                description: req.description,
                args: req.args,
                resolve,
              },
            });
          });
          this.#patch({ permission: null });
          return { decision };
        }
        if (method === "session/user_question") {
          const req = params as {
            sessionId: string;
            question?: string;
            prompt?: string;
            options?: string[];
          };
          const answer = await new Promise<{
            value: string;
            optionIndex?: number;
            cancelled?: boolean;
          }>((resolve) => {
            this.#patch({
              userQuestion: {
                sessionId: req.sessionId,
                question: req.question ?? req.prompt ?? "Question",
                ...(req.options !== undefined ? { options: req.options } : {}),
                resolve,
              },
            });
          });
          this.#patch({ userQuestion: null });
          return answer;
        }
        throw new Error(`unhandled server request: ${method}`);
      });

      client.onNotification("session/update", (params) => {
        const p = params as {
          sessionUpdate?: string;
          content?: { type?: string; text?: string };
          text?: string;
          toolName?: string;
        };
        if (p.sessionUpdate === "agent_message_chunk" || p.content?.text) {
          const text = p.content?.text ?? p.text ?? "";
          if (text) this.#appendAssistantChunk(text);
        } else if (p.toolName) {
          this.#pushMessage("tool", `tool: ${p.toolName}`);
        }
      });

      client.onNotification("session/token", () => {
        // Status strip can refresh later; keep quiet for MVP.
      });

      const init = (await client.request("initialize", {})) as {
        protocolVersion: number;
      };
      const session = (await client.request("session/new", {})) as {
        sessionId: string;
      };

      let config: Record<string, unknown> = {};
      try {
        config = (await client.request("config/get", {})) as Record<
          string,
          unknown
        >;
      } catch {
        // optional
      }

      let peerCount = 0;
      try {
        const peers = (await client.request("peers/list", {})) as {
          peers?: unknown[];
        };
        peerCount = peers.peers?.length ?? 0;
      } catch {
        peerCount = 0;
      }

      let policy = {
        sandbox: "read-only",
        approval: "on-request",
        autoRun: "always-confirm",
      };
      try {
        const res = (await client.request("session/get_policy", {
          sessionId: session.sessionId,
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

      this.#patch({
        ready: true,
        sessionId: session.sessionId,
        protocolVersion: init.protocolVersion,
        provider: String(config["provider"] ?? ""),
        model: String(config["model"] ?? ""),
        sandbox: policy.sandbox,
        approval: policy.approval,
        autoRun: policy.autoRun,
        peerCount,
        cwd: String(config["cwd"] ?? ""),
        error: null,
      });
    } catch (err) {
      this.#patch({
        ready: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  #appendAssistantChunk(text: string): void {
    const msgs = this.#state.messages;
    const last = msgs[msgs.length - 1];
    if (last !== undefined && last.role === "assistant") {
      const updated = [...msgs];
      updated[updated.length - 1] = {
        ...last,
        text: last.text + text,
      };
      this.#patch({ messages: updated });
    } else {
      this.#pushMessage("assistant", text);
    }
  }

  async prompt(text: string): Promise<void> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    this.#pushMessage("user", text);
    this.#patch({ busy: true, error: null });
    try {
      const res = (await client.request("session/prompt", {
        sessionId,
        text,
      })) as {
        stopReason?: string;
        messages?: Array<{ role?: string; text?: string }>;
      };
      const assistantTexts =
        res.messages
          ?.filter((m) => m.role === "assistant" && m.text)
          .map((m) => m.text!) ?? [];
      if (assistantTexts.length > 0) {
        const combined = assistantTexts.join("\n");
        const last = this.#state.messages[this.#state.messages.length - 1];
        if (!(last?.role === "assistant" && last.text.includes(combined))) {
          // Prefer streamed chunks; only push if no assistant text yet.
          const hasAssistant = this.#state.messages.some(
            (m) => m.role === "assistant" && m.at >= Date.now() - 120_000,
          );
          if (!hasAssistant || (last && last.role !== "assistant")) {
            this.#pushMessage("assistant", combined);
          }
        }
      }
    } catch (err) {
      this.#patch({
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.#patch({ busy: false });
    }
  }

  async cancel(): Promise<void> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) return;
    await client.request("session/cancel", { sessionId });
    this.#patch({ busy: false });
  }

  async setModel(provider: string, model: string): Promise<void> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    const res = (await client.request("session/set_model", {
      sessionId,
      provider,
      ...(model ? { model } : {}),
    })) as { result?: { provider?: string; model?: string } };
    this.#patch({
      provider: res.result?.provider ?? provider,
      model: res.result?.model ?? model,
    });
  }

  async setPolicy(policy: {
    sandbox?: string;
    approval?: string;
    autoRun?: string;
  }): Promise<void> {
    const client = this.#client;
    const sessionId = this.#state.sessionId;
    if (!client || !sessionId) throw new Error("not connected");
    const res = (await client.request("session/set_policy", {
      sessionId,
      ...policy,
    })) as {
      result?: { sandbox?: string; approval?: string; autoRun?: string };
    };
    this.#patch({
      sandbox: res.result?.sandbox ?? policy.sandbox ?? this.#state.sandbox,
      approval: res.result?.approval ?? policy.approval ?? this.#state.approval,
      autoRun: res.result?.autoRun ?? policy.autoRun ?? this.#state.autoRun,
    });
  }

  async listSessions(): Promise<SessionSummary[]> {
    const client = this.#client;
    if (!client) return [];
    const res = (await client.request("sessions/list", {})) as {
      sessions: SessionSummary[];
    };
    return res.sessions ?? [];
  }

  async resumeSession(sessionId: string): Promise<void> {
    const client = this.#client;
    if (!client) throw new Error("not connected");
    const res = (await client.request("session/load", {
      sessionId,
    })) as { sessionId: string };
    this.#patch({
      sessionId: res.sessionId,
      messages: [
        {
          id: nextMsgId(),
          role: "system",
          text: `Resumed session ${res.sessionId}`,
          at: Date.now(),
        },
      ],
    });
  }

  /** Raw RPC for EHUI data source. */
  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.#client) throw new Error("not connected");
    return this.#client.request(method, params);
  }

  onNotification(
    method: string,
    handler: (params: unknown) => void,
  ): () => void {
    if (!this.#client) return () => undefined;
    return this.#client.onNotification(method, handler);
  }

  close(): void {
    this.#client?.close();
    this.#client = undefined;
  }
}
