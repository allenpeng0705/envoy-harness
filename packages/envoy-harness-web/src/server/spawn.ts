/**
 * Resolve `envoy-harness --acp` for monorepo + installed layouts.
 * Mirrors `@envoymesh/envoy-harness-tui` spawn resolution.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    return {
      command: process.execPath,
      args: ["--import", "tsx", siblingTs, ...harnessArgs],
    };
  }

  return { command: "envoy-harness", args: harnessArgs };
}
