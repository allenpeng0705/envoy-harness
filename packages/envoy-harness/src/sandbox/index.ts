/**
 * OS sandbox — public API.
 *
 * **T3.4 scope:** the type seam + the no-op
 * default executor. The kernel backends
 * (landlock, process-fs-namespace) land in
 * T3.4.1 / T3.4.2 with a Linux test environment.
 */
export {
  NoopSandboxExecutor,
  type SandboxContext,
  type SandboxExecutor,
  type SandboxResult,
} from "./types.js";
