/**
 * F14 — session sub-module: the `PersistedSession`
 * (disk-backed `Session` impl) + the `SessionStore`
 * (directory-aware loader/saver/lister).
 *
 * **Re-exports** for the public API (Package 1
 * surface): the host wires these via
 * `Agent(session: PersistedSession)` or via
 * `SessionStore` for `--resume` / `--fork` flows.
 *
 * **T3.2:** `resolveSession` (the CLI's session
 * resolver for `--resume` / `--fork` / `--persist`)
 * lives here too. It used to be in `cli/run.ts`;
 * moving it next to the session types makes the
 * session sub-module the single home for everything
 * session-shaped.
 */

export { PersistedSession, type PersistedSessionCreateOptions } from "./persisted-session.js";
export { SessionStore, type SessionStoreOptions } from "./session-store.js";
export { resolveSession } from "./resolve.js";
export {
  PERSISTED_SESSION_FORMAT_VERSION,
  SUPPORTED_SESSION_FORMAT_VERSIONS,
  buildCreateHeader,
  resolveHeaderFormatVersion,
  type PersistedHeader,
} from "./format.js";
export { migrateSessionFile, type MigrateSessionFileResult } from "./migrate.js";
export {
  SessionFileBusyError,
  acquireSessionWriteLease,
  defaultWriteLeaseProvider,
  resetWriteLeaseProvider,
  setWriteLeaseProvider,
  type SessionWriteLease,
  type WriteLeaseProvider,
} from "./write-lease.js";
export {
  indexSessionDirectory,
  indexSessionFile,
  isPathInside,
  type SessionIndexEntry,
  type SessionIndexerOptions,
} from "./indexer.js";
export {
  createSessionQueryService,
  makeSessionQueryTool,
  registerSessionQueryTool,
  type SessionQueryHit,
  type SessionQueryRequest,
  type SessionQueryService,
  type SessionQueryServiceOptions,
} from "./query.js";
export {
  TurnOutlineRegistry,
  buildTurnOutlineFromMessages,
  loadTurnOutlineFromFile,
  type TurnOutline,
  type TurnOutlineEntry,
} from "./turn-outline.js";
