/**
 * @envoymesh/envoy-harness-cordis — Cordis-compat container (C0 spike).
 *
 * Currently hosts the deepseek jobs capability
 * (`@deepseek-ai/dsh-jobs-local`) on a real Cordis runtime. Grows
 * into the full container per `docs/cordis-compat-plan.md`.
 */

export {
  createCordisJobsHost,
  type CordisJobsHost,
  type CordisJobsHostOptions,
} from "./runtime.js";

export {
  createCordisContainer,
  resolvePluginManifest,
  type CordisCapability,
  type CordisContainer,
  type CordisPluginConfig,
  type CordisPluginState,
  type CordisPluginStatus,
  type CordisServiceOverride,
} from "./container.js";

export {
  CORDIS_PLUGINS,
  CORDIS_SERVICES,
  type CordisPluginManifest,
  type CordisServiceManifest,
} from "./whitelist.js";

export {
  EnvoyFileSystem,
  type EnvoyFileSystemOptions,
} from "./adapters/envoy-fs.js";

export {
  createHostedSkillsProvider,
  type HostedSkillsProviderOptions,
} from "./bridges/skills.js";

export { createHostedJobsRegistry } from "./bridges/jobs.js";
