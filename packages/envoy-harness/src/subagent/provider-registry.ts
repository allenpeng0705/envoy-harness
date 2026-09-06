/**
 * R4.15 — named subagent providers behind one {@link MeshSubmitter}.
 *
 * Hosts register `local` / `peer` / future external workers; the
 * `task` tool and workflow APIs keep a single submit surface.
 */

import type { MeshSubmitter, SubagentInput, SubagentResult } from "./types.js";

export type SubagentProviderKind = "local" | "peer" | "external";

export interface SubagentProvider {
  /** Stable id (e.g. `"local"`, `"peer:default"`, `"acp:codex"`). */
  id: string;
  kind: SubagentProviderKind;
  submitter: MeshSubmitter;
  /**
   * Optional predicate. When omitted, the provider accepts any input
   * (subject to registry routing order).
   */
  canHandle?(input: SubagentInput): boolean;
}

export interface SubagentProviderRegistryOptions {
  /** Fallback when no preferred / canHandle match (default `"local"`). */
  defaultProviderId?: string;
}

export class SubagentProviderError extends Error {
  override readonly name = "SubagentProviderError";
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "EMPTY" | "NO_MATCH" | "DUPLICATE",
  ) {
    super(message);
  }
}

/**
 * Composite {@link MeshSubmitter} over named providers.
 *
 * Routing order for {@link submit}:
 * 1. `input.preferredProviderId` (exact id)
 * 2. `input.preferredPeerId` → first `kind: "peer"` that `canHandle`s
 * 3. First registered provider whose `canHandle` is true / omitted
 * 4. `defaultProviderId` (if registered)
 * 5. First registered provider
 */
export class SubagentProviderRegistry implements MeshSubmitter {
  readonly #providers = new Map<string, SubagentProvider>();
  readonly #order: string[] = [];
  readonly #defaultProviderId: string;

  constructor(options: SubagentProviderRegistryOptions = {}) {
    this.#defaultProviderId = options.defaultProviderId ?? "local";
  }

  register(provider: SubagentProvider): () => void {
    if (this.#providers.has(provider.id)) {
      throw new SubagentProviderError(
        `subagent provider already registered: ${provider.id}`,
        "DUPLICATE",
      );
    }
    this.#providers.set(provider.id, provider);
    this.#order.push(provider.id);
    return () => {
      if (this.#providers.get(provider.id) === provider) {
        this.#providers.delete(provider.id);
        const idx = this.#order.indexOf(provider.id);
        if (idx !== -1) this.#order.splice(idx, 1);
      }
    };
  }

  get(id: string): SubagentProvider | undefined {
    return this.#providers.get(id);
  }

  list(): ReadonlyArray<SubagentProvider> {
    return this.#order
      .map((id) => this.#providers.get(id))
      .filter((p): p is SubagentProvider => p !== undefined);
  }

  /** Resolve which provider would handle `input` (no submit). */
  resolve(input: SubagentInput): SubagentProvider {
    if (this.#order.length === 0) {
      throw new SubagentProviderError(
        "no subagent providers registered",
        "EMPTY",
      );
    }

    if (input.preferredProviderId !== undefined) {
      const preferred = this.#providers.get(input.preferredProviderId);
      if (preferred === undefined) {
        throw new SubagentProviderError(
          `subagent provider not found: ${input.preferredProviderId}`,
          "NOT_FOUND",
        );
      }
      return preferred;
    }

    if (input.preferredPeerId !== undefined) {
      for (const id of this.#order) {
        const p = this.#providers.get(id);
        if (p === undefined || p.kind !== "peer") continue;
        if (p.canHandle === undefined || p.canHandle(input)) return p;
      }
    }

    // Prefer providers with an explicit canHandle match.
    for (const id of this.#order) {
      const p = this.#providers.get(id);
      if (p === undefined || p.canHandle === undefined) continue;
      if (p.canHandle(input)) return p;
    }

    // Then open providers (no canHandle).
    for (const id of this.#order) {
      const p = this.#providers.get(id);
      if (p === undefined || p.canHandle !== undefined) continue;
      return p;
    }

    const fallback = this.#providers.get(this.#defaultProviderId);
    if (fallback !== undefined) return fallback;

    const first = this.#providers.get(this.#order[0]!);
    if (first !== undefined) return first;

    throw new SubagentProviderError(
      "no subagent provider matched input",
      "NO_MATCH",
    );
  }

  async submit(
    input: SubagentInput,
    signal: AbortSignal,
  ): Promise<SubagentResult> {
    return this.resolve(input).submitter.submit(input, signal);
  }
}
