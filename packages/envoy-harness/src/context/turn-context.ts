/**
 * Assemble per-turn contextual fragments (skills, memories, plan)
 * before the model call — DeepSeek / Codex pattern.
 */

import {
  assembleFragments,
  type ContextualUserFragment,
} from "./fragment.js";
import { buildMemoryIndex } from "../memories/inject.js";
import type { MemoryStore } from "../memories/store.js";
import { buildPlanFragment } from "../plan/inject.js";
import type { PlanState } from "../plan/state.js";
import {
  createSkillCatalogFragment,
  nextCatalogMessage,
  skillCatalogDigest,
} from "../skills/catalog.js";
import type { SkillRegistry } from "../skills/registry.js";

export interface AssembleTurnContextOptions {
  cwd: string;
  signal: AbortSignal;
  memoryStore?: MemoryStore;
  skills?: SkillRegistry;
  /** Previous skill catalog digest (stable KV-cache prefix). */
  skillCatalogDigest?: string;
  plan?: PlanState;
  /** Token budget for assembled fragments (default 40_000). */
  budget?: number;
}

export interface AssembledTurnContext {
  /** Text to prepend as a user message (empty if nothing to inject). */
  text: string;
  /** Updated skill catalog digest. */
  skillCatalogDigest: string | undefined;
  included: ReadonlyArray<string>;
  dropped: ReadonlyArray<string>;
}

/**
 * Build budgeted turn context from memory index, skill catalog, and plan.
 */
export async function assembleTurnContext(
  options: AssembleTurnContextOptions,
): Promise<AssembledTurnContext> {
  const fragments: ContextualUserFragment[] = [];
  let nextDigest = options.skillCatalogDigest;

  if (options.plan !== undefined) {
    fragments.push(...buildPlanFragment(options.plan));
  }

  if (options.memoryStore !== undefined) {
    try {
      fragments.push(...(await buildMemoryIndex(options.memoryStore)));
    } catch {
      // Best-effort: over-budget or store errors must not fail the turn.
    }
  }

  if (options.skills !== undefined) {
    try {
      const summaries = await options.skills.list({
        cwd: options.cwd,
        signal: options.signal,
      });
      const catalog = nextCatalogMessage(
        summaries,
        options.skillCatalogDigest,
      );
      nextDigest = catalog.digest;
      if (catalog.changed && catalog.text.length > 0) {
        fragments.push(createSkillCatalogFragment(summaries));
      }
    } catch {
      // Best-effort.
    }
  }

  if (fragments.length === 0) {
    return {
      text: "",
      skillCatalogDigest: nextDigest,
      included: [],
      dropped: [],
    };
  }

  const assembled = assembleFragments(fragments, options.budget);
  return {
    text: assembled.text,
    skillCatalogDigest: nextDigest,
    included: assembled.included,
    dropped: assembled.dropped,
  };
}

export { skillCatalogDigest };
