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
import type { EnvironmentCapabilities } from "../environment/wire.js";

export interface CordisWireResult {
  dispose: () => Promise<void>;
  /** Replacement jobs registry when Cordis provides `jobs`. */
  jobs?: JobRegistry;
}

export interface CordisWireOptions {
  plugins: ReadonlyArray<{ name: string; config?: unknown }>;
  cwd: string;
  tools: ToolRegistry;
  jobs: JobRegistry;
  skills: SkillRegistry;
  web: WebRuntime;
}

export interface CordisEnvironmentWire {
  jobs: JobRegistry;
  cordisDispose?: () => Promise<void>;
}

/** Bridge Cordis plugins into an already-wired environment. */
export async function wireCordisExtensions(
  options: {
    plugins: ReadonlyArray<{ name: string; config?: unknown }> | undefined;
    cwd: string;
    tools: ToolRegistry;
    environment: EnvironmentCapabilities;
  },
): Promise<CordisEnvironmentWire> {
  if (options.plugins === undefined || options.plugins.length === 0) {
    return { jobs: options.environment.jobs };
  }
  const wired = await wireCordisFromConfig({
    plugins: options.plugins,
    cwd: options.cwd,
    tools: options.tools,
    jobs: options.environment.jobs,
    skills: options.environment.skills,
    web: options.environment.web,
  });
  if (wired === undefined) {
    return { jobs: options.environment.jobs };
  }
  return {
    jobs: wired.jobs ?? options.environment.jobs,
    cordisDispose: wired.dispose,
  };
}

/** Host whitelisted Cordis plugins when the optional package is installed. */
export async function wireCordisFromConfig(
  options: CordisWireOptions,
): Promise<CordisWireResult | undefined> {
  if (options.plugins.length === 0) return undefined;
  try {
    // @envoymesh/envoy-harness-cordis is an optional workspace peer. If
    // the package is not installed at runtime, the catch below returns
    // undefined and the harness runs without Cordis-backed plugins.
    const cordis = await import("@envoymesh/envoy-harness-cordis");
    const container = await cordis.createCordisContainer({
      plugins: options.plugins.map((p) => ({
        name: p.name,
        ...(p.config !== undefined ? { config: p.config } : {}),
      })),
    });
    const capabilities = container.capabilities();
    let jobs: JobRegistry | undefined;
    if (capabilities.some((c: { service: string }) => c.service === "jobs")) {
      jobs = cordis.createHostedJobsRegistry(container.ctx);
    }
    if (
      capabilities.some((c: { service: string }) => c.service === "skills")
    ) {
      options.skills.registerProvider(
        cordis.createHostedSkillsProvider(container.ctx),
      );
    }
    return {
      ...(jobs !== undefined ? { jobs } : {}),
      dispose: async () => {
        await container.dispose();
      },
    };
  } catch {
    return undefined;
  }
}
