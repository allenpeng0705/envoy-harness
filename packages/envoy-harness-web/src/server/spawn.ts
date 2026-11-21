/**
 * Resolve `envoy-harness --acp` for monorepo + installed layouts.
 * Mirrors `@envoymesh/envoy-harness-tui` spawn resolution.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute `tsx` loader so spawn cwd need not contain node_modules/tsx. */
export function resolveTsxImportSpecifier(): string {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("tsx/esm");
  } catch {
    return require.resolve("tsx");
  }
}

export function resolveHarnessAcpCommand(extraArgs: string[] = []): {
  command: string;
  args: string[];
} {
  const harnessArgs = ["--acp", ...extraArgs];
  if (process.env.ENVOY_HARNESS_BIN) {
    return { command: process.env.ENVOY_HARNESS_BIN, args: harnessArgs };
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const siblingTs = path.resolve(
    here,
    "../../../envoy-harness/bin/envoy-harness.ts",
  );
  if (existsSync(siblingTs)) {
    let tsxImport = "tsx";
    try {
      tsxImport = resolveTsxImportSpecifier();
    } catch {
      // fall back to bare "tsx" (works when spawn cwd has it hoisted)
    }
    return {
      command: process.execPath,
      args: ["--import", tsxImport, siblingTs, ...harnessArgs],
    };
  }

  return { command: "envoy-harness", args: harnessArgs };
}
