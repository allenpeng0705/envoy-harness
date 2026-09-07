#!/usr/bin/env node
/**
 * `envoy-harness-web` — spawn ACP + serve the browser UI.
 */

import { startWebServer } from "./start.js";

function printHelp(): void {
  process.stderr.write(
    [
      "envoy-harness-web — browser UI over ACP WebSocket",
      "",
      "Usage:",
      "  envoy-harness-web [flags]",
      "",
      "Flags:",
      "  --port <n>           HTTP port (default 5177)",
      "  --host <addr>        bind address (default 127.0.0.1)",
      "  --cwd <path>         working directory for ACP child",
      "  --provider <name>    forwarded to envoy-harness --acp",
      "  --model <id>         forwarded to envoy-harness --acp",
      "  --base-url <url>     forwarded to envoy-harness --acp",
      "  --persist            forwarded to envoy-harness --acp",
      "  --no-subagents       forwarded to envoy-harness --acp",
      "  --peers <id>@host:port  forwarded (repeatable)",
      "  --dev                force Vite middleware mode",
      "  --no-open            do not open a browser tab",
      "  --help               print this help",
      "",
    ].join("\n"),
  );
}

function parseArgv(argv: string[]): {
  port?: number;
  host?: string;
  cwd?: string;
  harnessArgs: string[];
  dev?: boolean;
  openBrowser: boolean;
  help: boolean;
} {
  const harnessArgs: string[] = [];
  let port: number | undefined;
  let host: string | undefined;
  let cwd: string | undefined;
  let dev: boolean | undefined;
  let openBrowser = true;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--dev") {
      dev = true;
      continue;
    }
    if (arg === "--no-open") {
      openBrowser = false;
      continue;
    }
    if (arg === "--persist" || arg === "--no-subagents") {
      harnessArgs.push(arg);
      continue;
    }
    if (
      arg === "--port" ||
      arg === "--host" ||
      arg === "--cwd" ||
      arg === "--provider" ||
      arg === "--model" ||
      arg === "--base-url" ||
      arg === "--peers"
    ) {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      i++;
      if (arg === "--port") {
        const n = Number(val);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --port: ${val}`);
        port = n;
      } else if (arg === "--host") {
        host = val;
      } else if (arg === "--cwd") {
        cwd = val;
      } else {
        harnessArgs.push(arg, val);
      }
      continue;
    }
    throw new Error(`unknown flag: ${arg}`);
  }

  return {
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    harnessArgs,
    ...(dev !== undefined ? { dev } : {}),
    openBrowser,
    help,
  };
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  const handle = await startWebServer({
    ...(parsed.port !== undefined ? { port: parsed.port } : {}),
    ...(parsed.host !== undefined ? { host: parsed.host } : {}),
    ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
    harnessArgs: parsed.harnessArgs,
    ...(parsed.dev !== undefined ? { dev: parsed.dev } : {}),
    openBrowser: parsed.openBrowser,
  });

  const shutdown = async (): Promise<void> => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((err) => {
  process.stderr.write(
    `envoy-harness-web: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
