/**
 * Phase C / Item 9 — persistent terminal public surface.
 */

export type {
  FakeTerminalBackendOptions,
  FakeTerminalSessionState,
} from "./fake-backend.js";
export { createFakeTerminalBackend } from "./fake-backend.js";

export {
  createPtyTerminalBackend,
  isPtyAvailable,
} from "./pty-backend.js";

export { createTerminalSessionService } from "./service.js";

export { makeTerminalTools, registerTerminalTools } from "./tools.js";

export type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalBackendSpawnSpec,
  TerminalErrorCode,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRequest,
  TerminalSendResult,
  TerminalSessionService,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
  TerminalSignal,
  TerminalSpawnRequest,
  TerminalWaitReason,
} from "./types.js";
export { TerminalError } from "./types.js";
