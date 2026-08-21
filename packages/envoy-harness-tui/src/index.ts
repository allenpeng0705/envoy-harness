/**
 * @envoymesh/envoy-harness-tui — Codex-style terminal host over ACP.
 */

export {
  createInProcessTui,
  type InProcessTui,
  type InProcessTuiOptions,
} from "./in-process.js";

export {
  createAttachedTui,
  type AttachedTui,
  type AttachedTuiOptions,
} from "./attached.js";

export {
  createSpawnedTui,
  resolveHarnessAcpCommand,
  type SpawnedTui,
  type SpawnedTuiOptions,
} from "./spawn.js";

export {
  TuiSession,
  type PermissionRequest,
  type TuiSessionOptions,
} from "./session.js";

export { parseSlash, type SlashResult } from "./slash.js";

export {
  formatTranscriptLine,
  type TranscriptLine,
  type TranscriptRole,
} from "./transcript.js";

export { runInteractive, type RunInteractiveOptions } from "./ui.js";
