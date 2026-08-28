/**
 * C1 — the audited plugin whitelist + known dsh service providers.
 *
 * Every entry must have an audit record (see `docs/audit-*.md`) before it
 * may load. The container refuses names not in this map.
 */

export interface CordisPluginManifest {
  /** The configured name (also the Cordis plugin's identity). */
  readonly name: string;
  /** dsh services this plugin registers on `ctx` (e.g. `jobs`, `skills`). */
  readonly provides: readonly string[];
  /** Service names that must be available before this plugin applies. */
  readonly requires: readonly string[];
  /** Relative path to the audit record (docs/audit-<name>.md). */
  readonly auditRef: string;
  /** Load the plugin module (class default or `{ apply, Config, ... }`). */
  load(): Promise<unknown>;
}

/** Built-in dsh service plugins the container applies on demand. */
export interface CordisServiceManifest {
  readonly name: string;
  /** Load the Service class (default export). */
  load(): Promise<unknown>;
}

/** Services the container knows how to provide (applied once when required). */
export const CORDIS_SERVICES: ReadonlyMap<string, CordisServiceManifest> =
  new Map([
    [
      "fs",
      {
        name: "fs",
        load: () =>
          // The abstract `dsh-fs` Service Definition needs a concrete
          // backend; deepseek publishes `dsh-fs-local` for that. A
          // sandbox-gated envoy fs adapter can replace this later (C2
          // hardening) without touching the whitelist shape.
          import("@deepseek-ai/dsh-fs-local").then((m) => m.default),
      },
    ],
    [
      "skills",
      {
        name: "skills",
        load: () =>
          import("@deepseek-ai/dsh-skill").then((m) => m.default),
      },
    ],
    [
      "web",
      {
        name: "web",
        load: () => import("@deepseek-ai/dsh-web").then((m) => m.default),
      },
    ],
    [
      "llm",
      {
        name: "llm",
        load: () => import("@deepseek-ai/dsh-llm").then((m) => m.default),
      },
    ],
  ]);

/** The audited plugin whitelist. Add a plugin here only with an audit record. */
export const CORDIS_PLUGINS: ReadonlyMap<string, CordisPluginManifest> =
  new Map([
    [
      "jobs-local",
      {
        name: "jobs-local",
        provides: ["jobs"],
        requires: [],
        auditRef: "docs/audit-jobs-local.md",
        load: () =>
          import("@deepseek-ai/dsh-jobs-local").then((m) => m.default),
      },
    ],
    [
      "skill-filesystem",
      {
        name: "skill-filesystem",
        provides: [],
        requires: ["fs", "skills"],
        auditRef: "docs/audit-skill-filesystem.md",
        load: () => import("@deepseek-ai/dsh-skill-filesystem"),
      },
    ],
    [
      "credentials-local",
      {
        name: "credentials-local",
        // LocalCredentialProvider extends the abstract CredentialProvider
        // Service — applying it registers `ctx.credentials` itself.
        provides: ["credentials"],
        requires: [],
        auditRef: "docs/audit-credentials-local.md",
        load: () =>
          import("@deepseek-ai/dsh-credentials-local").then(
            (m) => m.default ?? m,
          ),
      },
    ],
    [
      "web-search-exa",
      {
        name: "web-search-exa",
        provides: [],
        requires: ["web", "llm"],
        auditRef: "docs/audit-web-search-exa.md",
        // The package is a named-exports plugin namespace (`apply`, `Config`,
        // `name`, `inject`) — no default export.
        load: () => import("@deepseek-ai/dsh-web-search-exa"),
      },
    ],
  ]);
