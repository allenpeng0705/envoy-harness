/**
 * C4 — bridge hosted dsh skills into envoy-harness's native skill
 * registry, so envoy's own model-facing `skill` tool can load skills
 * provided by deepseek plugins (e.g. `skill-filesystem`).
 */

import type { Context } from "@deepseek-ai/cordis";
import type {
  SkillDefinition,
  SkillProvider,
  SkillSummary,
} from "@envoymesh/envoy-harness";

export interface HostedSkillsProviderOptions {
  /** Provider name surfaced in envoy summaries (default `"cordis-hosted"`). */
  name?: string;
}

/** Adapt `ctx.skills` (the dsh contract) to envoy's `SkillProvider`. */
export function createHostedSkillsProvider(
  ctx: Context,
  options: HostedSkillsProviderOptions = {},
): SkillProvider {
  const providerName = options.name ?? "cordis-hosted";
  return {
    name: providerName,
    async list({ cwd, signal }): Promise<ReadonlyArray<SkillSummary>> {
      const summaries = await ctx.skills.list({ cwd, signal });
      return summaries.map((s) => ({
        name: s.name,
        description: s.description,
        ...(s.whenToUse !== undefined ? { whenToUse: s.whenToUse } : {}),
        provider: providerName,
        invocation: {
          modelInvocable: true,
          userInvocable: true,
        },
      }));
    },
    async get(name, { cwd, signal }): Promise<SkillDefinition | undefined> {
      const def = await ctx.skills.get(name, { cwd, signal });
      if (def === undefined) return undefined;
      return {
        name: def.name,
        description: def.description,
        ...(def.whenToUse !== undefined ? { whenToUse: def.whenToUse } : {}),
        provider: providerName,
        invocation: {
          modelInvocable: true,
          userInvocable: true,
        },
        resourceBase:
          def.resourceBase !== undefined && "path" in def.resourceBase
            ? def.resourceBase.path
            : "",
        instructions: def.content,
      };
    },
  };
}
