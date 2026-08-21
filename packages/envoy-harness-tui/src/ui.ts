/**
 * Interactive readline loop (TTY host).
 */

import * as readline from "node:readline";

import type { TuiSession } from "./session.js";
import { formatTranscriptLine } from "./transcript.js";

export interface RunInteractiveOptions {
  session: TuiSession;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** Run until `/quit` or input ends. */
export async function runInteractive(
  options: RunInteractiveOptions,
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const { session } = options;

  let printed = 0;
  const flush = (): void => {
    const lines = session.transcript;
    while (printed < lines.length) {
      const line = lines[printed];
      if (line !== undefined) {
        output.write(`${formatTranscriptLine(line)}\n`);
      }
      printed++;
    }
  };

  await session.start();
  flush();

  const rl = readline.createInterface({
    input,
    output,
    terminal: Boolean((input as NodeJS.ReadStream).isTTY),
  });

  const prompt = (): void => {
    rl.setPrompt(session.busy ? "… " : "> ");
    rl.prompt();
  };

  prompt();

  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      void (async () => {
        if (session.pendingPermission !== undefined) {
          const d = line.trim().toLowerCase();
          if (d === "allow" || d === "a" || d === "y") {
            session.answerPermission("allow");
            flush();
            prompt();
            return;
          }
          if (d === "deny" || d === "d" || d === "n") {
            session.answerPermission("deny");
            flush();
            prompt();
            return;
          }
        }

        const result = await session.submit(line);
        flush();
        if (result === "quit") {
          rl.close();
          resolve();
          return;
        }
        prompt();
      })();
    });
    rl.on("close", () => resolve());
  });
}
