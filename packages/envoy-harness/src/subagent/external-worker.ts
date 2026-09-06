/**
 * R4.16 — external agent workers (ACP / Codex / Claude) as
 * {@link MeshSubmitter} backends for {@link SubagentProviderRegistry}.
 *
 * *Their* agents, *our* distribution: hosts inject a transport; Package 1
 * only defines the seam + hermetic fake (no Codex/Claude SDKs).
 */

import type { MeshSubmitter, SubagentInput, SubagentResult } from "./types.js";
import type { SubagentProviderRegistry } from "./provider-registry.js";

export type ExternalWorkerKind = "acp" | "codex" | "claude";

/** Minimal prompt/response surface every external worker must expose. */
export interface ExternalWorkerTransport {
  /**
   * Run one objective on the external agent.
   * Returns assistant text (and optional cost metadata).
   */
  prompt(
    objective: string,
    signal: AbortSignal,
  ): Promise<{
    text: string;
    costUsd?: number;
  }>;
}

export interface ExternalAgentWorker {
  /** Provider id (e.g. `"acp:codex"`, `"claude:default"`). */
  id: string;
  kind: ExternalWorkerKind;
  transport: ExternalWorkerTransport;
  /**
   * Optional capability filter — when set, registry `canHandle` uses it.
   * Default: accept all.
   */
  capabilityTags?: ReadonlyArray<string>;
}

export interface ExternalWorkerSubmitterOptions {
  /** Stamped on {@link SubagentResult.workerPeerId} (default: worker id). */
  workerPeerId?: string;
}

function toResult(
  workerId: string,
  text: string,
  startedAt: number,
  costUsd: number,
): SubagentResult {
  return {
    status: "completed",
    content: [{ type: "text", text }],
    workerPeerId: workerId,
    workerRuntime: "envoy-harness",
    costUsd,
    durationMs: Date.now() - startedAt,
    verdict: { kind: "pass", score: 1, confidence: "medium" },
    signature: "",
  };
}

/**
 * Wrap an {@link ExternalAgentWorker} as a {@link MeshSubmitter}.
 */
export function createExternalWorkerSubmitter(
  worker: ExternalAgentWorker,
  options: ExternalWorkerSubmitterOptions = {},
): MeshSubmitter {
  const peerId = options.workerPeerId ?? worker.id;
  return {
    async submit(input: SubagentInput, signal: AbortSignal): Promise<SubagentResult> {
      const startedAt = Date.now();
      try {
        const out = await worker.transport.prompt(input.objective, signal);
        return toResult(peerId, out.text, startedAt, out.costUsd ?? 0);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          status: "failed",
          content: [{ type: "text", text: reason }],
          workerPeerId: peerId,
          workerRuntime: "envoy-harness",
          costUsd: 0,
          durationMs: Date.now() - startedAt,
          verdict: { kind: "fail", reason, rollback: false },
          signature: "",
        };
      }
    },
  };
}

/**
 * Register an external worker on a {@link SubagentProviderRegistry}.
 */
export function registerExternalWorker(
  registry: SubagentProviderRegistry,
  worker: ExternalAgentWorker,
  options?: ExternalWorkerSubmitterOptions,
): () => void {
  const tags = worker.capabilityTags;
  return registry.register({
    id: worker.id,
    kind: "external",
    submitter: createExternalWorkerSubmitter(worker, options),
    ...(tags !== undefined
      ? {
          canHandle: (input: SubagentInput) =>
            tags.length === 0 || tags.includes(input.capabilityTag),
        }
      : {}),
  });
}

/**
 * Hermetic fake transport — scripted responses for CI.
 */
export class FakeExternalWorkerTransport implements ExternalWorkerTransport {
  readonly #handler: (
    objective: string,
  ) => { text: string; costUsd?: number } | Promise<{ text: string; costUsd?: number }>;

  constructor(
    handler:
      | string
      | ((
          objective: string,
        ) =>
          | { text: string; costUsd?: number }
          | Promise<{ text: string; costUsd?: number }>),
  ) {
    this.#handler =
      typeof handler === "string"
        ? () => ({ text: handler })
        : handler;
  }

  async prompt(
    objective: string,
    signal: AbortSignal,
  ): Promise<{ text: string; costUsd?: number }> {
    if (signal.aborted) {
      throw new Error("external worker aborted");
    }
    return this.#handler(objective);
  }
}

/** Convenience: build a typed worker with a fake or real transport. */
export function createExternalAgentWorker(options: {
  id: string;
  kind: ExternalWorkerKind;
  transport: ExternalWorkerTransport;
  capabilityTags?: ReadonlyArray<string>;
}): ExternalAgentWorker {
  return {
    id: options.id,
    kind: options.kind,
    transport: options.transport,
    ...(options.capabilityTags !== undefined
      ? { capabilityTags: options.capabilityTags }
      : {}),
  };
}
