#!/usr/bin/env -S npx tsx
/**
 * envoy-peer — the standalone envoy-harness peer CLI binary.
 *
 * `envoy-peer serve` starts a MAP-over-JSON-RPC peer over TCP
 * (`src/cli/serve.ts`); `envoy-peer ui` starts the dedicated cluster
 * console TUI over a connected peer cluster (`src/cli/ui.ts`). The
 * shebang runs from source via tsx; after `pnpm build` the package's
 * `bin` entry points here too.
 */

import { runPeerServeCli } from "../src/cli/serve.js";
import { runPeerUiCli } from "../src/cli/ui.js";

const argv = process.argv.slice(2);
const subcommand = argv[0];
const code =
  subcommand === "ui"
    ? await runPeerUiCli(argv.slice(1))
    : subcommand === "serve" || subcommand === undefined
      ? await runPeerServeCli(subcommand === "serve" ? argv.slice(1) : argv)
      : (() => {
          process.stderr.write(
            `envoy-peer: unknown subcommand "${subcommand}" (expected serve | ui)\n`,
          );
          return 2;
        })();
process.exitCode = code;
