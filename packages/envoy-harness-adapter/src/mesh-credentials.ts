/**
 * Phase G — mesh credentials transport seam (item 13).
 *
 * Package 1 rejects `source: "mesh"`. The host injects a
 * transport that fetches secrets over the mesh; this module
 * wraps it as a `CredentialsProvider` for composition outside
 * Package 1.
 */

import type {
  CredentialReference,
  CredentialsProvider,
  ResolveCredentialOptions,
} from "@envoymesh/envoy-harness";

/** Host-supplied fetch for a named mesh credential. */
export interface MeshCredentialsTransport {
  fetch(
    name: string,
    opts: { signal: AbortSignal },
  ): Promise<string>;
  /** Optional: advertise refs the transport can resolve. */
  list?(): CredentialReference[];
}

/**
 * CredentialsProvider that only answers `source: "mesh"`
 * (or omitted source when used behind a mesh-only cascade).
 */
export function createMeshCredentialsProvider(
  transport: MeshCredentialsTransport,
): CredentialsProvider {
  return {
    async resolve(ref, opts: ResolveCredentialOptions): Promise<string> {
      if (ref.source !== undefined && ref.source !== "mesh") {
        throw new Error(
          `mesh credentials provider cannot resolve source=${ref.source}`,
        );
      }
      return transport.fetch(ref.name, { signal: opts.signal });
    },
    list(): CredentialReference[] {
      return (
        transport.list?.() ??
        []
      ).map((r) => ({ ...r, source: "mesh" as const }));
    },
  };
}
