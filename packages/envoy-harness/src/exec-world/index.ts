/**
 * R4.14b — exec-world public surface.
 */

export type {
  ExecReadResult,
  ExecShellRequest,
  ExecShellResult,
  ExecWorld,
  ExecWorldTarget,
  RemoteExecTransport,
} from "./types.js";
export { ExecWorldError } from "./types.js";
export { createLocalExecWorld } from "./local.js";
export {
  FakeRemoteExecTransport,
  createPeerExecWorld,
} from "./peer.js";
