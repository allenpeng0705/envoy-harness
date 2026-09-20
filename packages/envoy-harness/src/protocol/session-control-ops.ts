/**
 * Backend operations for two host-facing surfaces that are not about the
 * agent turn loop: the project (workspace) registry and steering a
 * background sub-agent.
 *
 * **Why a separate module.** `agent-backend.ts` is at the module-size cap;
 * these operations are pure functions of a submitter / registry, so they
 * are both easy to test in isolation and the right thing to move out. The
 * backend methods become one-line delegations.
 */

import type {
  ContinuableSubagentHandle,
  ContinuableSubmitter,
  MeshSubmitter,
} from "../subagent/index.js";
import type { WorkspaceEntry, WorkspaceRegistry } from "../workspace/index.js";
import { formatSubagentRecords, subagentRecordsToWire } from "./session-ops.js";

/**
 * Resolve a continuable child handle, when both the submitter and the id
 * support it. Returns `undefined` (rather than throwing) so the protocol
 * layer can answer with a structured "no such child" instead of a
 * JSON-RPC error for an ordinary race — a child can settle between the UI
 * listing it and the user steering it.
 */
export function continuableHandle(
  submitter: MeshSubmitter | undefined,
  agentId: string,
): ContinuableSubagentHandle | undefined {
  if (submitter === undefined) return undefined;
  const candidate = submitter as Partial<ContinuableSubmitter>;
  if (typeof candidate.getHandle !== "function") return undefined;
  return candidate.getHandle(agentId);
}

/** How much of a running child's live output to ship to a UI. */
const OUTPUT_PREVIEW_CHARS = 400;

/**
 * `session/agents` — the human rendering **and** the same records as data.
 *
 * The data arm carries the full id (the handle the control ops need), a
 * `steerable` flag, and — for a running child — a tail of its live output
 * so a UI can show progress without a second round trip.
 */
export function listSessionAgentsOp(submitter: MeshSubmitter | undefined): {
  output: string;
  agents: ReturnType<typeof subagentRecordsToWire>;
} {
  const records =
    submitter !== undefined &&
    typeof submitter.listSubagents === "function"
      ? submitter.listSubagents()
      : [];
  return {
    output: formatSubagentRecords(records),
    agents: subagentRecordsToWire(records, (id) => {
      const handle = continuableHandle(submitter, id);
      // A handle only exists while the child can actually be steered: the
      // runtime drops it on settle (which also releases the child's Agent).
      // Check the status too, so a submitter that keeps settled handles
      // cannot make a dead child look steerable.
      const live =
        handle !== undefined && handle.status().status === "running";
      if (!live) return { steerable: false };
      const text = handle.output();
      return text.length > 0
        ? { steerable: true, outputPreview: text.slice(-OUTPUT_PREVIEW_CHARS) }
        : { steerable: true };
    }),
  };
}

/** `session/agent_message` — steer a continuable child. */
export async function sendAgentMessageOp(
  submitter: MeshSubmitter | undefined,
  params: { agentId: string; message: string },
): Promise<{ queued: boolean; status: string; error?: string }> {
  const handle = continuableHandle(submitter, params.agentId);
  if (handle === undefined) {
    return {
      queued: false,
      status: "unknown",
      error: `no continuable child '${params.agentId}' in this session`,
    };
  }
  try {
    await handle.send(params.message);
  } catch (err) {
    return {
      queued: false,
      status: handle.status().status,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { queued: true, status: handle.status().status };
}

/** `session/agent_interrupt` — stop a child's current turn. */
export async function interruptAgentOp(
  submitter: MeshSubmitter | undefined,
  params: { agentId: string; reason?: string },
): Promise<{ interrupted: boolean; status: string; error?: string }> {
  const handle = continuableHandle(submitter, params.agentId);
  if (handle === undefined) {
    return {
      interrupted: false,
      status: "unknown",
      error: `no continuable child '${params.agentId}' in this session`,
    };
  }
  handle.interrupt(params.reason);
  return { interrupted: true, status: handle.status().status };
}

/**
 * `workspace/list`. An unwired registry answers with an empty list —
 * "no projects yet" and "project support is off" are indistinguishable to
 * a picker, and an empty list is the honest answer in both cases.
 */
export async function listWorkspacesOp(
  registry: WorkspaceRegistry | undefined,
): Promise<{ workspaces: WorkspaceEntry[] }> {
  if (registry === undefined) return { workspaces: [] };
  return { workspaces: [...(await registry.list())] };
}

/** `workspace/add`. */
export async function addWorkspaceOp(
  registry: WorkspaceRegistry | undefined,
  params: { path: string; name?: string },
): Promise<{ workspace: WorkspaceEntry }> {
  if (registry === undefined) {
    throw new Error("workspace registry not wired");
  }
  const entry = await registry.add(
    params.path,
    params.name !== undefined ? { name: params.name } : undefined,
  );
  return { workspace: entry };
}

/** `workspace/remove` — forget a project; never deletes the directory. */
export async function removeWorkspaceOp(
  registry: WorkspaceRegistry | undefined,
  params: { path: string },
): Promise<{ removed: boolean }> {
  if (registry === undefined) {
    throw new Error("workspace registry not wired");
  }
  return { removed: await registry.remove(params.path) };
}
