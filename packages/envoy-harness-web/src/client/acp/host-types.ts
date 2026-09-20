/**
 * Shared types for the browser ACP host.
 */

export type ChatRole = "user" | "assistant" | "system" | "tool" | "status";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected";

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

/**
 * A project registered with the server's workspace registry.
 *
 * Mirrors the `workspace/list` / `workspace/add` payload. `path` is an
 * absolute directory path; removing an entry only forgets it — it never
 * deletes the directory.
 */
export interface WorkspaceEntry {
  path: string;
  name: string;
  addedAt: string;
  lastUsedAt?: string;
}

/** Reply of `session/agent_message`. `error` is a normal miss, not a throw. */
export interface AgentMessageResult {
  queued: boolean;
  status: string;
  error?: string;
}

/** Reply of `session/agent_interrupt`. `error` is a normal miss. */
export interface AgentInterruptResult {
  interrupted: boolean;
  status: string;
  error?: string;
}

export type MeshAgentStatus =
  | "running"
  | "completed"
  | "failed"
  | "partial"
  | "unknown";

/**
 * A locally spawned child agent, as reported by `session/agents`.
 *
 * `id` is the **full** session id and the handle used by
 * `session/agent_message` / `session/agent_interrupt`. Only `steerable`
 * children currently have a live handle, so the rail disables the
 * controls for the rest.
 */
export interface MeshAgent {
  id: string;
  capabilityTag: string;
  objective: string;
  status: MeshAgentStatus;
  startedAt: string;
  completedAt?: string;
  costUsd?: number;
  durationMs?: number;
  steerable: boolean;
  /**
   * Tail of a running child's output. The backend updates it from the
   * child's assistant deltas, so the rail shows progress *within* a turn,
   * not only after each turn completes.
   */
  outputPreview?: string;
}

export interface MeshSnapshot {
  connected: number;
  peerTotal: number;
  failed: number;
  peers: Array<{ id: string; ok: boolean; model?: string; error?: string }>;
  teamJobsRunning: number;
  teamJobsTotal: number;
  agentsSummary: string;
  /**
   * Structured child agents. Absent when the host only returned the
   * preformatted `output` (older/custom backends) — callers then fall
   * back to `agentsSummary` and must not offer steering.
   */
  agents?: MeshAgent[];
  lastDiscovery?: string;
}

export interface AcpHostState {
  connectionState: ConnectionState;
  ready: boolean;
  busy: boolean;
  sessionId: string | null;
  protocolVersion: number | null;
  model: string;
  provider: string;
  /** Optional API base URL override (OpenAI-/Anthropic-compatible). */
  baseUrl: string;
  sandbox: string;
  approval: string;
  autoRun: string;
  peerCount: number;
  mesh: MeshSnapshot | null;
  cwd: string;
  messages: ChatMessage[];
  error: string | null;
  retryAttempt: number;
  permission: PermissionPrompt | null;
  userQuestion: UserQuestionPrompt | null;
}
