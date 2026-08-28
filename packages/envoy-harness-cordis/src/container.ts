/**
 * C1 — the Cordis-compat container core.
 *
 * Boots a real `@deepseek-ai/cordis` root context, applies required dsh
 * service providers + the configured whitelisted plugins in dependency
 * order, and owns the lifecycle (status snapshots, ordered dispose,
 * error isolation — a failing plugin disables itself, not the container).
 */

import { Context, type Fiber } from "@deepseek-ai/cordis";

import {
  CORDIS_PLUGINS,
  CORDIS_SERVICES,
  type CordisPluginManifest,
} from "./whitelist.js";

export interface CordisPluginConfig {
  /** A name in the whitelist (`CORDIS_PLUGINS`). */
  name: string;
  /** Plugin config passed through to `ctx.plugin(module, config)`. */
  config?: unknown;
}

/** A host-supplied service override (e.g. the sandbox-gated envoy fs
 *  adapter replacing the published `dsh-fs-local` default). */
export interface CordisServiceOverride {
  /** The service key the plugin requires (e.g. `"fs"`). */
  name: string;
  /** The service plugin/class to apply. */
  module: unknown;
  /** Config passed to the service's constructor/apply. */
  config?: unknown;
}

export type CordisPluginState = "applied" | "failed";

export interface CordisPluginStatus {
  name: string;
  state: CordisPluginState;
  /** Failure reason (only when `state === "failed"`). */
  error?: string;
  /** Applied order (0-based); useful for `/cordis` output. */
  order: number;
}

export interface CordisContainer {
  /** The live Cordis root context (services are on it: `ctx.jobs`, …). */
  readonly ctx: Context;
  /** Status of every configured plugin, in apply order. */
  status(): readonly CordisPluginStatus[];
  /**
   * C4 — the hosted capability surface for hosts (EnvoyMesh / Tauri):
   * each ctx service that is present and which provider registered it.
   * Hosts use this to route capabilities (e.g. skills → the envoy skill
   * registry, jobs → job tools) without reaching into Cordis internals.
   */
  capabilities(): readonly CordisCapability[];
  /** Dispose all fibers in reverse apply order + the root fiber. Idempotent. */
  dispose(): Promise<void>;
}

/** One hosted capability: a ctx service + the provider that registered it. */
export interface CordisCapability {
  /** The ctx service key (e.g. `jobs`, `skills`, `credentials`, `web`). */
  readonly service: string;
  /** The whitelisted plugin name, or `<service>` for a container-applied
   *  dsh service (e.g. the published SkillRegistry backend). */
  readonly provider: string;
}

/** Resolve the plugin manifest for a configured name (throws on unknown). */
export function resolvePluginManifest(name: string): CordisPluginManifest {
  const manifest = CORDIS_PLUGINS.get(name);
  if (!manifest) {
    throw new Error(
      `cordis plugin not in whitelist: ${name} ` +
        `(known: ${[...CORDIS_PLUGINS.keys()].join(", ")})`,
    );
  }
  return manifest;
}

/**
 * Boot a Cordis container. Resolves once every configured plugin has
 * been applied (or failed). A plugin failure never rejects the whole
 * container — it's recorded in `status()` and the rest continue.
 */
export async function createCordisContainer(opts: {
  plugins: readonly CordisPluginConfig[];
  /** Host-supplied service overrides (applied when required). */
  services?: readonly CordisServiceOverride[];
  /** Controller name for the hosted jobs service (default
   *  `"envoy-harness-host"`). The dsh registry refuses to start jobs
   *  without an attached controller — the host composition's job. */
  hostControllerName?: string;
}): Promise<CordisContainer> {
  const ctx = new Context();
  const fibers: Array<{ name: string; dispose: () => Promise<void> }> = [];
  const appliedServices = new Set<string>();
  const providedBy = new Map<string, string>();
  const statuses: CordisPluginStatus[] = [];
  let disposed = false;
  let nextOrder = 0;

  const applyService = async (serviceName: string): Promise<void> => {
    if (appliedServices.has(serviceName)) return;
    appliedServices.add(serviceName);
    const override = opts.services?.find((s) => s.name === serviceName);
    let module: unknown;
    let config: unknown;
    if (override !== undefined) {
      module = override.module;
      config = override.config;
    } else {
      const service = CORDIS_SERVICES.get(serviceName);
      if (!service) {
        throw new Error(`cordis service provider unknown: ${serviceName}`);
      }
      module = await service.load();
    }
    const fiber = applyPlugin(ctx, module, config);
    await fiber;
    fibers.push({ name: serviceName, dispose: () => fiber.dispose() });
    if (!providedBy.has(serviceName)) {
      providedBy.set(serviceName, `${serviceName} (dsh service)`);
    }
  };

  for (const entry of opts.plugins) {
    let failed = "";
    try {
      const manifest = resolvePluginManifest(entry.name);
      // Satisfy the plugin's declared service requirements first.
      for (const required of manifest.requires) {
        await applyService(required);
      }
      const module = await manifest.load();
      const fiber = applyPlugin(ctx, module, entry.config);
      await fiber;
      fibers.push({ name: entry.name, dispose: () => fiber.dispose() });
      for (const provided of manifest.provides) {
        providedBy.set(provided, entry.name);
      }
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }
    statuses.push({
      name: entry.name,
      state: failed === "" ? "applied" : "failed",
      ...(failed !== "" ? { error: failed } : {}),
      order: nextOrder++,
    });
  }

  // The host's job controller: the dsh jobs contract refuses `start`
  // unless some controller serves the owner. Attach one for the whole
  // container so hosted jobs are usable out of the box.
  if (ctx.jobs !== undefined) {
    const detach = ctx.jobs.attachController(
      opts.hostControllerName ?? "envoy-harness-host",
    );
    fibers.push({
      name: "host-controller",
      dispose: async () => {
        detach();
      },
    });
  }

  return {
    ctx,
    status: () => statuses,
    capabilities: () =>
      [...providedBy.entries()].map(([service, provider]) => ({
        service,
        provider,
      })),
    async dispose() {
      if (disposed) return;
      disposed = true;
      // Reverse apply order (children before parents).
      for (const fiber of [...fibers].reverse()) {
        try {
          await fiber.dispose();
        } catch {
          // Best-effort teardown; a throwing disposer must not prevent
          // the remaining fibers from unloading.
        }
      }
      await ctx.fiber?.dispose();
    },
  };
}

/** Cordis plugin application with a loose signature (modules are `unknown`
 *  from the whitelist loader; Cordis validates the real shape). */
function applyPlugin(
  ctx: Context,
  module: unknown,
  config?: unknown,
): Fiber {
  return (ctx.plugin as (m: unknown, c?: unknown) => Fiber)(
    module,
    config,
  );
}
