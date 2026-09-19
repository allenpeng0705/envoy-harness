/**
 * Sandbox failure classification.
 *
 * **The gap this closes.** envoy reported a sandboxed command's failure
 * as `isError: childExitCode !== 0` (`sandbox/backends/spawn-capture.ts`)
 * and overloaded exit code 125 for "sandbox infrastructure unavailable".
 * It therefore could not tell:
 *
 * - **"the sandbox blocked this write"** — a policy outcome the model can
 *   act on (retry a narrower path, ask for a writable root, explain to
 *   the user), from
 * - **"the command itself failed"** — a program bug, and from
 * - **"the sandbox could not start"** — an environment problem where
 *   retrying the command is pointless.
 *
 * All three arrived as an opaque non-zero exit, so the model's only move
 * was to guess.
 *
 * **The classification rules** (ported from codex's `sandboxing::violation`):
 *
 * - **Quick-reject exit codes 2 / 126 / 127 are NOT denials.** They are
 *   ordinary shell failures (`2` misuse, `126` not executable, `127` not
 *   found). Labelling them denials would produce a false "retry with a
 *   wider sandbox" prompt for a typo — the single most important
 *   guard here.
 * - A **known denial keyword** plus a backend that enforces policy is a
 *   denial; the denied path is extracted when the message names one.
 * - Exit `125` is envoy's launcher-failure code and is reported as
 *   **infrastructure**, a separate channel from `denied`.
 *
 * Everything is pure, so the whole table is testable with fixtures.
 */

import type { SandboxBackend } from "../types.js";

export type SandboxViolationBackend =
  | "landlock"
  | "seatbelt"
  | "windows-job"
  | "windows-sidecar"
  | "fs-namespace"
  | "none";

export type DenialReason =
  | "operation_not_permitted"
  | "permission_denied"
  | "read_only_file_system"
  | "policy_denied"
  | "failed_to_write_file"
  | "signal_syscall";

export interface SandboxDenial {
  readonly kind: "denied";
  readonly backend: SandboxViolationBackend;
  readonly reason: DenialReason;
  /** Absolute or `./`-relative path named by the failure, when present. */
  readonly path?: string;
  /** Bounded excerpt for the transcript / trace. */
  readonly outputSnippet: string;
}

export interface SandboxInfrastructureFailure {
  readonly kind: "infrastructure";
  readonly backend: SandboxViolationBackend;
  readonly detail: string;
  readonly outputSnippet: string;
}

export type SandboxFailure = SandboxDenial | SandboxInfrastructureFailure;

/** Envoy's launcher/infrastructure failure exit code. */
export const SANDBOX_LAUNCHER_FAILURE_EXIT = 125;

/** Highest exit code that a shell uses for "could not run this". */
const QUICK_REJECT_EXIT_CODES = new Set([2, 126, 127]);

/** Excerpt cap: enough to diagnose, never a context sink. */
export const OUTPUT_SNIPPET_MAX_CHARS = 512;

/** Keyword → reason. Order matters: the first match wins. */
const REASON_KEYWORDS: ReadonlyArray<[RegExp, DenialReason]> = [
  [/read-only file system/i, "read_only_file_system"],
  [/operation not permitted/i, "operation_not_permitted"],
  [/permission denied/i, "permission_denied"],
  [/failed to write file/i, "failed_to_write_file"],
  [/sandbox[_\s-]?denied|policy denied|denied by sandbox/i, "policy_denied"],
  [/landlock|seatbelt|sandbox-exec|seccomp/i, "policy_denied"],
];

/** Backends that actually enforce filesystem policy. */
const ENFORCING_BACKENDS = new Set<SandboxViolationBackend>([
  "landlock",
  "seatbelt",
  "windows-job",
  "windows-sidecar",
  "fs-namespace",
]);

/**
 * Map the session's configured {@link SandboxBackend} onto the
 * classification vocabulary.
 *
 * The two enums are deliberately separate: `types.ts` names *what we
 * configured* (a user-facing setting, e.g. `darwin-sandbox`) and this
 * module names *what the kernel actually did* (e.g. `seatbelt`). Keeping
 * the mapping in one place means a new backend cannot silently fall into
 * the "enforcing" set by accident — an unmapped value classifies as
 * `none` and therefore never produces a denial.
 */
export function policyToViolationBackend(
  backend: SandboxBackend,
): SandboxViolationBackend {
  switch (backend) {
    case "linux-landlock":
      return "landlock";
    case "darwin-sandbox":
      return "seatbelt";
    case "windows-sandbox":
      return "windows-job";
    case "process-fs-namespace":
      return "fs-namespace";
    case "none":
      return "none";
    default:
      return "none";
  }
}

function snippet(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= OUTPUT_SNIPPET_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, OUTPUT_SNIPPET_MAX_CHARS - 1)}…`;
}

/**
 * Extract a path the failure names.
 *
 * Only absolute or explicitly relative paths are accepted: a bare word
 * before a colon is far more likely to be a program name or a device than
 * a path we should report as the denied target. Three phrasings cover
 * essentially every real message:
 *
 * - `touch: cannot touch '/etc/hosts': Permission denied` (coreutils)
 * - `cannot open /tmp/x for writing` (shell builtins, BSD)
 * - `Permission denied: '/etc/passwd'` (interpreters, syscall wrappers)
 */
export function extractDeniedPath(text: string): string | undefined {
  const path = `['"]?((?:/|\\.\\.?/)[^\\s:'"]+)['"]?`;
  const errno =
    "(?:operation not permitted|permission denied|read-only file system|failed to write file)";
  const patterns = [
    // `<path>: <errno>` — the GNU coreutils shape.
    new RegExp(`(?:^|\\s)${path}:\\s*${errno}`, "i"),
    // `cannot <verb> <path>` — the BSD / shell shape.
    new RegExp(
      `(?:cannot|can't|could not)\\s+(?:open|write|create|read|unlink|rename|mkdir|touch|remove)\\s+${path}`,
      "i",
    ),
    // `<errno>: <path>` — the syscall-wrapper shape.
    new RegExp(`${errno}:\\s*${path}`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const candidate = match?.[1];
    if (candidate !== undefined && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Classify a sandboxed command's failure.
 *
 * @returns `undefined` when the failure is an ordinary program failure
 *   (the caller should report it as-is).
 */
export function classifySandboxFailure(options: {
  backend: SandboxViolationBackend;
  exitCode: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}): SandboxFailure | undefined {
  const output = `${options.stderr ?? ""}\n${options.stdout ?? ""}`;
  const text = snippet(output);

  // A launcher failure means the SANDBOX could not run the command.
  if (options.exitCode === SANDBOX_LAUNCHER_FAILURE_EXIT) {
    return {
      kind: "infrastructure",
      backend: options.backend,
      detail: text.length > 0 ? text : "sandbox launcher failed",
      outputSnippet: text,
    };
  }

  // `SIGSYS` from a seccomp filter is a denial by definition.
  if (options.signal === "SIGSYS") {
    return denial(options.backend, "signal_syscall", output, text);
  }

  // Quick-reject codes are NEVER denials (this is the false-positive guard).
  if (options.exitCode !== null && QUICK_REJECT_EXIT_CODES.has(options.exitCode)) {
    return undefined;
  }

  // Only a backend that enforces policy can produce a policy denial.
  if (!ENFORCING_BACKENDS.has(options.backend)) return undefined;

  for (const [pattern, reason] of REASON_KEYWORDS) {
    if (!pattern.test(output)) continue;
    return denial(options.backend, reason, output, text);
  }
  return undefined;
}

function denial(
  backend: SandboxViolationBackend,
  reason: DenialReason,
  output: string,
  text: string,
): SandboxDenial {
  const path = extractDeniedPath(output);
  return {
    kind: "denied",
    backend,
    reason,
    ...(path !== undefined ? { path } : {}),
    outputSnippet: text,
  };
}

/** True when the failure is a policy denial (not infrastructure). */
export function isSandboxDenial(
  failure: SandboxFailure | undefined,
): failure is SandboxDenial {
  return failure?.kind === "denied";
}

/**
 * The model-facing explanation for a denial.
 *
 * Deliberately actionable: the model cannot fix a sandbox policy by
 * retrying the identical command, so the text says what changed and what
 * the options are.
 */
export function describeSandboxDenial(failure: SandboxDenial): string {
  const where = failure.path !== undefined ? ` on \`${failure.path}\`` : "";
  return (
    `blocked by the ${failure.backend} sandbox${where} ` +
    `(${failure.reason.replace(/_/g, " ")}). This is a POLICY decision, not a ` +
    "program error — re-running the same command will fail identically. " +
    "Either work within the sandbox (write inside the workspace), or ask the " +
    "user to widen it (`/sandbox workspace-write` or an explicit writable root)."
  );
}

/**
 * The model-facing explanation for an infrastructure failure.
 *
 * The actionable content is the opposite of a denial: the command never
 * ran, so re-running *is* the right move once the environment is fixed —
 * but retrying immediately would spin, so the text says so.
 */
export function describeSandboxInfrastructureFailure(
  failure: SandboxInfrastructureFailure,
): string {
  return (
    `the ${failure.backend} sandbox could not start the command, so it never ` +
    `ran (exit ${SANDBOX_LAUNCHER_FAILURE_EXIT}). This is an ENVIRONMENT ` +
    "problem, not a program error — retrying the identical command will not " +
    "help until the sandbox is available. Check that the sandbox helper is " +
    "installed and executable on this host, or ask the user to run without it."
  );
}

/**
 * One-line, model-facing annotation for a classified failure, or
 * `undefined` when the failure is ordinary and needs no annotation.
 *
 * Callers append this to the tool output *without* replacing the raw
 * stderr: the model needs both the explanation and the evidence.
 */
export function formatSandboxFailure(
  failure: SandboxFailure | undefined,
): string | undefined {
  if (failure === undefined) return undefined;
  const body =
    failure.kind === "denied"
      ? describeSandboxDenial(failure)
      : describeSandboxInfrastructureFailure(failure);
  return `[sandbox] ${body}`;
}
