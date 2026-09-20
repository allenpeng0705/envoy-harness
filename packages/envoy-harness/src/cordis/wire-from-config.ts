/**
 * Optional Cordis-compat container wire-up.
 *
 * **Why the module is loaded through a `string` variable.** A dynamic
 * import with a *literal* specifier is still resolved by `tsc`, so core
 * needed the Cordis package's declarations to build — and Cordis depends
 * on core, so nothing could build from a clean checkout. Typing the
 * specifier as `string` makes the import opaque to the type checker (and
 * to bundlers), and the surface core actually uses is declared locally as
 * {@link CordisCompatModule}. The runtime import is unchanged: the package
 * is still optional and a missing one is caught below.
 */

import type { ToolRegistry } from "../tools/registry.js";
import type { JobRegistry } from "../jobs/index.js";
import type { SkillRegistry } from "../skills/index.js";
import type { WebRuntime } from "../web/types.js";
import type { EnvironmentCapabilities } from "../environment/wire.js";

/** The subset of the Cordis container the harness drives. */
interface CordisContainerLike {
  capabilities(): ReadonlyArray<{ service: string }>;
  ctx: unknown;
  dispose(): Promise<void>;
}

/** The subset of `@envoymesh/envoy-harness-cordis` the harness calls. */
interface CordisCompatModule {
  createCordisContainer(options: {
    plugins: ReadonlyArray<{ name: string; config?: unknown }>;
  }): Promise<CordisContainerLike>;
  createHostedJobsRegistry(ctx: unknown): JobRegistry;
  createHostedSkillsProvider(
    ctx: unknown,
  ): Parameters<SkillRegistry["registerProvider"]>[0];
}

const CORDIS_PACKAGE: string = "@envoymesh/envoy-harness-cordis";

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
    // Loaded by name (not a literal specifier): optional at runtime, and
    // invisible to the build, which is what keeps core independent of a
    // package that depends on core. A missing package falls into the catch
    // below and the harness runs without Cordis-backed plugins.
    const cordis = (await import(CORDIS_PACKAGE)) as CordisCompatModule;
    const container = await cordis.createCordisContainer({
      plugins: options.plugins.map((p) => ({
        name: p.name,
        ...(p.config !== undefined ? { config: p.config } : {}),
      })),
    });
    const capabilities = container.capabilities();
    let jobs: JobRegistry | undefined;
    if (capabilities.some((c) => c.service === "jobs")) {
      jobs = cordis.createHostedJobsRegistry(container.ctx);
    }
    if (capabilities.some((c) => c.service === "skills")) {
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
