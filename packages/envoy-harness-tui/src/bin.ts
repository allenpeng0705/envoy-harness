#!/usr/bin/env node
/**
 * envoy-harness-tui — interactive ACP host.
 *
 * Modes:
 * - `--demo` (default): in-process fake backend
 * - `--spawn`: child `envoy-harness --acp` over stdio
 */

import { createFakeSessionBackend } from "@envoymesh/envoy-harness";

import { createInProcessTui } from "./in-process.js";
import { createSpawnedTui } from "./spawn.js";
import { runInteractive } from "./ui.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`envoy-harness-tui — terminal host for envoy-harness (ACP)

Usage:
  envoy-harness-tui [--demo | --spawn] [--ask-permission]

  --demo            in-process fake backend (default)
  --spawn           spawn \`envoy-harness --acp\` and attach over stdio
  --ask-permission  demo backend asks allow/deny once (demo mode only)
  --help            show this help

Env:
  ENVOY_HARNESS_BIN  override harness executable for --spawn

Inside the TUI: /help /cancel /quit
Permission prompts: type allow or deny
`);
    return;
  }

  if (args.includes("--spawn")) {
    const tui = createSpawnedTui({ cwd: process.cwd(), stderr: "inherit" });
    try {
      process.stdout.write(
        "envoy-harness-tui (spawned --acp) — /help for commands\n",
      );
      await runInteractive({ session: tui.session });
    } finally {
      tui.close();
    }
    return;
  }

  const tui = createInProcessTui({
    cwd: process.cwd(),
    backend: createFakeSessionBackend({
      ...(args.includes("--ask-permission")
        ? { permissionTool: "bash" }
        : {}),
    }),
  });

  try {
    process.stdout.write(
      "envoy-harness-tui (demo backend) — /help for commands\n",
    );
    await runInteractive({ session: tui.session });
  } finally {
    tui.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
