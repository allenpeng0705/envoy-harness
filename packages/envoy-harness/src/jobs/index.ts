/**
 * Phase C / Item 7 — background jobs public surface.
 */

export type {
  JobDoneListener,
  JobHooks,
  JobOutcome,
  JobRead,
  JobRegistry,
  JobSnapshot,
  JobStart,
  JobStatus,
} from "./types.js";
export { JobError } from "./types.js";

export {
  createLocalJobRegistry,
  type LocalJobRegistryOptions,
} from "./registry.js";

export {
  createProcessJobHooks,
  type ProcessJobOptions,
} from "./process-provider.js";

export { makeJobTools, registerJobTools } from "./tools.js";

export {
  FakeRemoteJobTransport,
  NOOP_REMOTE_JOB_TRANSPORT,
  RemoteJobError,
  formatRemoteJobRef,
  isRemoteJobRef,
  parseRemoteJobRef,
  parseRemotePeerId,
  type RemoteJobRef,
  type RemoteJobTransport,
} from "./remote.js";
