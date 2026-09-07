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

export interface MeshSnapshot {
  connected: number;
  peerTotal: number;
  failed: number;
  peers: Array<{ id: string; ok: boolean; model?: string; error?: string }>;
  teamJobsRunning: number;
  teamJobsTotal: number;
  agentsSummary: string;
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
