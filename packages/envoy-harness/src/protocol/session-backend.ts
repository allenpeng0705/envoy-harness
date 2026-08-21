/**
 * Phase E — shared session backend for ACP + SDK dialects.
 */

export interface ProtocolPermissionRequest {
  sessionId: string;
  toolName: string;
  description: string;
  args: unknown;
}

export type ProtocolPermissionDecision = "allow" | "deny";

export interface ProtocolCommittedMessage {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
}

export interface ProtocolPromptResult {
  stopReason: string;
  messages: ProtocolCommittedMessage[];
}

export interface ProtocolToolInfo {
  name: string;
  description: string;
}

export interface ProtocolSessionBackend {
  createSession(params?: { cwd?: string }): Promise<{ sessionId: string }>;
  prompt(params: {
    sessionId: string;
    text: string;
    signal: AbortSignal;
    requestPermission: (
      req: ProtocolPermissionRequest,
    ) => Promise<ProtocolPermissionDecision>;
    onUpdate?: (msg: ProtocolCommittedMessage) => void;
  }): Promise<ProtocolPromptResult>;
  cancel(sessionId: string): void;
  listTools?(): ProtocolToolInfo[];
  getConfig?(): Record<string, unknown>;
}

/** In-memory backend for hermetic protocol tests. */
export function createFakeSessionBackend(options?: {
  tools?: ProtocolToolInfo[];
  config?: Record<string, unknown>;
  permissionTool?: string;
}): ProtocolSessionBackend & {
  cancelled: string[];
  prompts: Array<{ sessionId: string; text: string }>;
} {
  let seq = 0;
  const sessions = new Set<string>();
  const aborts = new Map<string, AbortController>();
  const cancelled: string[] = [];
  const prompts: Array<{ sessionId: string; text: string }> = [];
  const tools = options?.tools ?? [
    { name: "bash", description: "Run a shell command" },
  ];

  return {
    cancelled,
    prompts,
    async createSession() {
      const sessionId = `sess-${++seq}`;
      sessions.add(sessionId);
      return { sessionId };
    },
    async prompt(params) {
      if (!sessions.has(params.sessionId)) {
        throw new Error(`unknown session: ${params.sessionId}`);
      }
      prompts.push({ sessionId: params.sessionId, text: params.text });
      const ac = new AbortController();
      aborts.set(params.sessionId, ac);
      const onAbort = (): void => ac.abort();
      params.signal.addEventListener("abort", onAbort, { once: true });

      try {
        if (options?.permissionTool !== undefined) {
          const decision = await params.requestPermission({
            sessionId: params.sessionId,
            toolName: options.permissionTool,
            description: `Allow ${options.permissionTool}?`,
            args: {},
          });
          if (decision === "deny") {
            return {
              stopReason: "permission_denied",
              messages: [{ role: "assistant", text: "permission denied" }],
            };
          }
        }
        if (ac.signal.aborted || params.signal.aborted) {
          return {
            stopReason: "cancelled",
            messages: [{ role: "assistant", text: "cancelled" }],
          };
        }
        const assistant: ProtocolCommittedMessage = {
          role: "assistant",
          text: `echo:${params.text}`,
        };
        params.onUpdate?.(assistant);
        return {
          stopReason: "end_turn",
          messages: [
            { role: "user", text: params.text },
            assistant,
          ],
        };
      } finally {
        params.signal.removeEventListener("abort", onAbort);
        aborts.delete(params.sessionId);
      }
    },
    cancel(sessionId) {
      cancelled.push(sessionId);
      aborts.get(sessionId)?.abort();
    },
    listTools: () => tools,
    getConfig: () => options?.config ?? { version: "0.0.0" },
  };
}
