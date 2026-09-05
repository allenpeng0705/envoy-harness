/**
 * R4.3 — explicit adjacent-successor session migrations.
 *
 * `PersistedSession.open` never rewrites the file. Callers that need
 * v2 must invoke {@link migrateSessionFile} first.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  PERSISTED_SESSION_FORMAT_VERSION,
  type PersistedHeader,
  resolveHeaderFormatVersion,
} from "./format.js";

export interface MigrateSessionFileResult {
  fromVersion: number;
  toVersion: number;
  generation: number;
  filePath: string;
}

export interface MigrateSessionFileOptions {
  /** Keep a `.v1.bak` copy of the pre-migration file. Default true. */
  backup?: boolean;
}

/**
 * Migrate a session JSONL file from v1 → v2 (adjacent only).
 * Idempotent guard: already-v2 throws.
 */
export async function migrateSessionFile(
  filePath: string,
  options: MigrateSessionFileOptions = {},
): Promise<MigrateSessionFileResult> {
  const backup = options.backup !== false;
  const raw = await fs.readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error(`empty session file: ${filePath}`);
  }
  const header = JSON.parse(lines[0]!) as PersistedHeader;
  if (header._kind !== "header") {
    throw new Error(`first line is not a header: ${filePath}`);
  }
  const fromVersion = resolveHeaderFormatVersion(header);
  if (fromVersion === PERSISTED_SESSION_FORMAT_VERSION) {
    throw new Error(
      `already format version ${fromVersion}; nothing to migrate`,
    );
  }
  if (fromVersion !== 1) {
    throw new Error(
      `no adjacent migration from formatVersion ${fromVersion} ` +
        `to ${PERSISTED_SESSION_FORMAT_VERSION}`,
    );
  }

  const nextHeader: PersistedHeader = {
    ...header,
    formatVersion: 2,
    generation: 1,
    migratedFrom: { formatVersion: fromVersion },
  };

  const tmpPath = `${filePath}.migrate-${process.pid}.tmp`;
  const outLines = [JSON.stringify(nextHeader), ...lines.slice(1)];
  await fs.writeFile(tmpPath, outLines.join("\n") + "\n", "utf-8");

  if (backup) {
    const bak = `${filePath}.v${fromVersion}.bak`;
    await fs.copyFile(filePath, bak);
  }

  await fs.rename(tmpPath, filePath);

  return {
    fromVersion,
    toVersion: 2,
    generation: 1,
    filePath: path.resolve(filePath),
  };
}
