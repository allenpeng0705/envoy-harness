/**
 * Optional Cordis-compat container wire-up.
 *
 * Dynamic import keeps `@envoymesh/envoy-harness-cordis` optional
 * (not a hard dependency of Package 1).
 */

import type { ToolRegistry } from "../tools/registry.js";
import type { JobRegistry } from "../jobs/index.js";
import type { SkillRegistry } from "../skills/index.js";
import type { WebRuntime } from "../web/types.js";

export interface CordisWireResult {
  dispose: () => Promise<void>;
}

export interface CordisWireOptions {
  plugins: ReadonlyArray<{ name: string; config?: unknown }>;
  cwd: string;
  tools: ToolRegistry;
  jobs: JobRegistry;
  skills: SkillRegistry;
  web: WebRuntime;
}

/** Host whitelisted Cordis plugins when the optional package is installed. */
export async function wireCordisFromConfig(
  options: CordisWireOptions,
): Promise<CordisWireResult | undefined> {
  if (options.plugins.length === 0) return undefined;
  try {
    // Optional peer package — not a hard dependency of Package 1.
    // @ts-expect-error optional workspace package
    const cordis = await import("@envoymesh/envoy-harness-cordis");
    const container = await cordis.createCordisContainer({
      plugins: options.plugins.map((p) => ({
        name: p.name,
        ...(p.config !== undefined ? { config: p.config } : {}),
      })),
    });
    return {
      dispose: async () => {
        await container.dispose();
      },
    };
  } catch {
    return undefined;
  }
}
