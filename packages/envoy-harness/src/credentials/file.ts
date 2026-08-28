/**
 * Phase C / Item 13 — file-backed credentials (JSON, mode 0600).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type {
  CredentialReference,
  CredentialsProvider,
} from "./types.js";
import { CredentialError } from "./types.js";

export interface FileCredentialsOptions {
  /** Absolute path to a JSON object `{ "NAME": "value", ... }`. */
  filePath: string;
  /** Skip the 0600 permission check (tests on platforms without mode). */
  skipPermissionCheck?: boolean;
}

export function createFileCredentialsProvider(
  options: FileCredentialsOptions,
): CredentialsProvider {
  let cache: Record<string, string> | undefined;

  async function load(): Promise<Record<string, string>> {
    if (cache !== undefined) return cache;
    let raw: string;
    try {
      raw = await fs.readFile(options.filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new CredentialError(
          `credentials file not found: ${options.filePath}`,
          "NOT_FOUND",
        );
      }
      throw err;
    }

    if (!options.skipPermissionCheck && process.platform !== "win32") {
      const st = await fs.stat(options.filePath);
      const mode = st.mode & 0o777;
      if (mode & 0o077) {
        throw new CredentialError(
          `credentials file ${options.filePath} must be mode 0600 (got ${mode.toString(8)})`,
          "PERMISSION",
        );
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CredentialError(
        `credentials file is not valid JSON: ${options.filePath}`,
        "INVALID",
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CredentialError(
        "credentials file must be a JSON object",
        "INVALID",
      );
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    cache = out;
    return out;
  }

  return {
    async resolve(ref) {
      if (ref.source !== "file") {
        throw new CredentialError(
          `file provider cannot resolve source=${ref.source}`,
          "INVALID",
        );
      }
      const data = await load();
      const key = ref.key ?? ref.name;
      const value = data[key];
      if (value === undefined || value === "") {
        throw new CredentialError(
          `file credential '${key}' not found in ${path.basename(options.filePath)}`,
          "NOT_FOUND",
        );
      }
      return value;
    },
    list() {
      // Sync list without I/O: advertise nothing until loaded.
      // Callers that need names should resolve explicitly.
      if (cache === undefined) return [];
      return Object.keys(cache).map(
        (name): CredentialReference => ({ name, source: "file" }),
      );
    },
  };
}
