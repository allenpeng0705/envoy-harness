/**
 * Project-local config trust gate.
 *
 * **The vulnerability this closes.** `.envoy/config.toml` is read from
 * the *current working directory* and merged ABOVE the user's own
 * config (`layers.ts`). Before this module, a repository could ship:
 *
 * ```toml
 * # .envoy/config.toml, committed by whoever wrote the repo
 * permissionPreset = "approve-all"   # → danger-full-access + never ask
 * hooks = [{ event = "PreToolUse", … }]  # → run arbitrary commands
 * mcpServers = [{ command = "…" }]       # → spawn arbitrary processes
 * ```
 *
 * …and simply cloning the repo and running `envoy-harness` inside it
 * would silently lift the sandbox, disable approvals, and execute the
 * repo's commands. That is a prompt-injection → RCE path: repository
 * contents are attacker-controlled input, and config is not code the
 * user chose to trust.
 *
 * **The rule (from codex `sanitize_project_config`):** repository
 * contents must not be able to turn an ordinary key into a permission
 * increase. Security-relevant keys are stripped from the project layer,
 * and the stripped keys are *reported* rather than silently dropped, so
 * a legitimate user can see what the repo tried to do and opt in
 * explicitly.
 *
 * **Opt-in.** A user who genuinely trusts a repository (their own
 * monorepo, a reviewed checkout) can record it in
 * `~/.local/state/envoy-harness/trusted-projects.json` via
 * {@link trustProject} — after which the full project layer applies.
 * Trust is keyed by the resolved project directory, never by name.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ConfigLayer } from "./schema.js";

/**
 * Keys a repository-committed config may NOT set.
 *
 * The list is exhaustive over `ConfigLayerSchema`'s security-relevant
 * keys — a test asserts every entry is a real schema key, so this cannot
 * silently rot into a no-op when the schema grows.
 *
 * Grouped by why, because the grouping is the review argument:
 */
export const PROJECT_LOCAL_DENYLIST: ReadonlySet<string> = new Set([
  // 1. Permission escalation: these decide what the agent may do and
  //    whether the human is asked.
  "permissionMode",
  "askForApproval",
  "permissionPreset",
  "autoRun",
  "sandboxBackend",
  // 2. Sandbox breadth: the same escalation expressed as paths/network.
  "networkAccess",
  "slashTmpWritable",
  "writableRoots",
  // 3. Code/process execution the repo would supply: hooks run shell
  //    commands, MCP servers and Cordis plugins spawn or load code.
  "hooks",
  "mcpServers",
  "plugins",
  "cordisPlugins",
  // 4. Where the agent's work and prompts are sent. A repo pointing
  //    `peers` at an attacker-controlled node would exfiltrate the
  //    prompt and every sub-agent task.
  "peers",
  // 5. Process-environment injection (BASH_ENV / ZDOTDIR / NODE_OPTIONS
  //    are code execution by another name).
  "shellEnvironmentPolicy",
  // 6. Silent system-prompt / persona replacement. AGENTS.md is the
  //    reviewed, visible channel for project instructions; a hidden
  //    config override that outranks the user's own setting is not.
  "persona",
  "developerInstructions",
]);

/** The result of sanitizing a project layer. */
export interface SanitizedProjectLayer {
  /** The project layer with denied keys removed. */
  readonly layer: ConfigLayer;
  /** Denied keys that were present (for the user-facing warning). */
  readonly ignoredKeys: ReadonlyArray<string>;
}

/**
 * Strip security-relevant keys from a project-local config layer.
 *
 * Pure: no filesystem access, so it is directly unit-testable and can
 * be applied to any layer source.
 */
export function sanitizeProjectLayer(raw: ConfigLayer): SanitizedProjectLayer {
  const kept: Record<string, unknown> = {};
  const ignoredKeys: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (PROJECT_LOCAL_DENYLIST.has(key)) {
      ignoredKeys.push(key);
      continue;
    }
    kept[key] = value;
  }
  return { layer: kept as ConfigLayer, ignoredKeys };
}

/** Directory holding the trust record (same root as session state). */
export function trustedProjectsPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["HOME"] ?? os.homedir();
  return path.join(home, ".local", "state", "envoy-harness", "trusted-projects.json");
}

/**
 * Whether `projectDir` has been explicitly trusted.
 *
 * Fails closed: an unreadable or malformed trust file means "not
 * trusted", never "trusted".
 */
export async function isProjectTrusted(
  projectDir: string,
  filePath: string = trustedProjectsPath(),
): Promise<boolean> {
  const resolved = path.resolve(projectDir);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return false;
    return parsed.some(
      (entry) => typeof entry === "string" && path.resolve(entry) === resolved,
    );
  } catch {
    return false;
  }
}

/** Record `projectDir` as trusted. Idempotent. */
export async function trustProject(
  projectDir: string,
  filePath: string = trustedProjectsPath(),
): Promise<void> {
  const resolved = path.resolve(projectDir);
  const existing = await readTrustList(filePath);
  if (existing.includes(resolved)) return;
  existing.push(resolved);
  await writeTrustList(existing, filePath);
}

/** Remove `projectDir` from the trust list. Idempotent. */
export async function untrustProject(
  projectDir: string,
  filePath: string = trustedProjectsPath(),
): Promise<void> {
  const resolved = path.resolve(projectDir);
  const existing = await readTrustList(filePath);
  const next = existing.filter((entry) => entry !== resolved);
  if (next.length === existing.length) return;
  await writeTrustList(next, filePath);
}

/** Every trusted project directory, in insertion order. */
export async function listTrustedProjects(
  filePath: string = trustedProjectsPath(),
): Promise<ReadonlyArray<string>> {
  return readTrustList(filePath);
}

async function readTrustList(filePath: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === "string");
  } catch {
    return [];
  }
}

async function writeTrustList(
  entries: ReadonlyArray<string>,
  filePath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(tmp, filePath);
}

/**
 * The user-facing warning for a sanitized project config.
 *
 * Names the file, the keys, and the exact way to opt in — a warning the
 * user cannot act on is only noise.
 */
export function projectConfigWarning(
  projectPath: string,
  ignoredKeys: ReadonlyArray<string>,
  trustPath: string = trustedProjectsPath(),
): string {
  return (
    `envoy-harness: ignoring ${ignoredKeys.length} security-relevant key(s) in ` +
    `${projectPath}: ${ignoredKeys.join(", ")}.\n` +
    `  A repository must not be able to lift your sandbox, disable approvals, ` +
    `or run its own commands.\n` +
    `  If you trust this checkout, add it to ${trustPath} (one absolute path ` +
    `per JSON string) or call trustProject() from a host.`
  );
}
