/**
 * R4.3 — persisted session format versions + header helpers.
 *
 * Adjacent-successor discipline: readers accept supported versions;
 * writers emit the current version; migrations are explicit (never
 * silent on open).
 */

import type { SessionMetadata } from "../session.js";

/** Current writer format. Bumped in R4.3 for `generation`. */
export const PERSISTED_SESSION_FORMAT_VERSION = 2 as const;

/** Versions `PersistedSession.open` may load without migrating. */
export const SUPPORTED_SESSION_FORMAT_VERSIONS = [1, 2] as const;

export type SupportedSessionFormatVersion =
  (typeof SUPPORTED_SESSION_FORMAT_VERSIONS)[number];

export interface PersistedHeader {
  _kind: "header";
  id: string;
  metadata: SessionMetadata;
  /**
   * On-disk format version. Optional on v1 legacy files;
   * required for v2+.
   */
  formatVersion?: number;
  /**
   * Monotonic generation for the file identity (v2+).
   * Starts at 1 on create / after migrate.
   */
  generation?: number;
  /** Optional provenance when an explicit migrate wrote this file. */
  migratedFrom?: {
    formatVersion: number;
  };
}

export function isSupportedFormatVersion(
  version: number,
): version is SupportedSessionFormatVersion {
  return (SUPPORTED_SESSION_FORMAT_VERSIONS as readonly number[]).includes(
    version,
  );
}

/**
 * Normalize a parsed header's format version.
 * Missing → v1 (legacy). Throws on unsupported / invalid.
 */
export function resolveHeaderFormatVersion(header: PersistedHeader): number {
  if (header.formatVersion === undefined) {
    return 1;
  }
  if (typeof header.formatVersion !== "number") {
    throw new Error(
      `invalid formatVersion (expected number, got ${typeof header.formatVersion})`,
    );
  }
  if (!isSupportedFormatVersion(header.formatVersion)) {
    throw new Error(
      `unsupported formatVersion ${header.formatVersion} ` +
        `(supported: ${SUPPORTED_SESSION_FORMAT_VERSIONS.join(", ")}); ` +
        `run migrateSessionFile for adjacent upgrades`,
    );
  }
  if (header.formatVersion >= 2) {
    if (
      typeof header.generation !== "number" ||
      !Number.isFinite(header.generation) ||
      header.generation < 1
    ) {
      throw new Error(
        `formatVersion ${header.formatVersion} requires generation >= 1`,
      );
    }
  }
  return header.formatVersion;
}

/** Build a header for a newly created session (current writer version). */
export function buildCreateHeader(
  id: string,
  metadata: SessionMetadata,
): PersistedHeader {
  return {
    _kind: "header",
    id,
    metadata,
    formatVersion: PERSISTED_SESSION_FORMAT_VERSION,
    generation: 1,
  };
}
