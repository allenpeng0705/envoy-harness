/**
 * Phase C / Item 13 — composite credentials provider.
 *
 * Resolution order when `source` is omitted by callers that
 * use `resolveByName`: env → file → ask. Explicit `source`
 * skips the cascade.
 */

import type {
  CredentialReference,
  CredentialsProvider,
  ResolveCredentialOptions,
} from "./types.js";
import { CredentialError } from "./types.js";

export interface CompositeCredentialsOptions {
  env: CredentialsProvider;
  file: CredentialsProvider;
  ask: CredentialsProvider;
  /** Extra refs advertised by `list()` (union of backends). */
}

/** Create the default cascade provider. */
export function createCredentialsProvider(
  backends: CompositeCredentialsOptions,
): CredentialsProvider & {
  resolveByName(
    name: string,
    opts: ResolveCredentialOptions,
  ): Promise<string>;
  /** Values resolved this session — for redaction. */
  revealedValues(): ReadonlySet<string>;
} {
  const revealed = new Set<string>();

  const bySource = (
    source: CredentialReference["source"],
  ): CredentialsProvider => {
    switch (source) {
      case "env":
        return backends.env;
      case "file":
        return backends.file;
      case "ask":
        return backends.ask;
      case "mesh":
        throw new CredentialError(
          "mesh credentials belong in the adapter (Package 3)",
          "MESH_FORBIDDEN",
        );
    }
  };

  async function resolve(
    ref: CredentialReference,
    opts: ResolveCredentialOptions,
  ): Promise<string> {
    if (ref.source === "mesh") {
      throw new CredentialError(
        "mesh credentials belong in the adapter (Package 3)",
        "MESH_FORBIDDEN",
      );
    }
    const value = await bySource(ref.source).resolve(ref, opts);
    if (value.length > 0) revealed.add(value);
    return value;
  }

  return {
    resolve,
    list() {
      const seen = new Set<string>();
      const out: CredentialReference[] = [];
      for (const p of [backends.env, backends.file, backends.ask]) {
        for (const ref of p.list()) {
          const key = `${ref.source}:${ref.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(ref);
        }
      }
      return out;
    },
    async resolveByName(name, opts) {
      for (const source of ["env", "file", "ask"] as const) {
        try {
          return await resolve({ name, source }, opts);
        } catch (err) {
          if (
            err instanceof CredentialError &&
            (err.code === "NOT_FOUND" || err.code === "CANCELLED")
          ) {
            continue;
          }
          throw err;
        }
      }
      throw new CredentialError(
        `credential '${name}' not found in env/file/ask`,
        "NOT_FOUND",
      );
    },
    revealedValues: () => revealed,
  };
}
