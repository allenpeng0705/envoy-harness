/**
 * Minimal fake sidecar for R6.3 hermetic tests (newline JSON IPC).
 * Supports execute (long sleep until cancel), cancel, and a short echo.
 */

import * as readline from "node:readline";

const inFlight = new Map();

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    write({ id: "", ok: false, error: "invalid JSON" });
    continue;
  }
  if (req.method === "cancel") {
    const ac = inFlight.get(req.params?.id);
    if (ac) ac.abort();
    write({ id: req.id, ok: true, result: { cancelled: true } });
    continue;
  }
  if (req.method === "ping") {
    write({ id: req.id, ok: true, result: { pong: true, platform: process.platform } });
    continue;
  }
  if (req.method === "execute") {
    const ac = new AbortController();
    inFlight.set(req.id, ac);
    const cmd = String(req.params?.command ?? "");
    void (async () => {
      try {
        // Soft-fail fixture: never respond; cancel ack does not abort.
        if (cmd.includes("HANG_IGNORE_CANCEL")) {
          return;
        }
        if (cmd.includes("SLEEP_LONG")) {
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 30_000);
            ac.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                resolve();
              },
              { once: true },
            );
          });
          write({
            id: req.id,
            ok: true,
            result: {
              stdout: "",
              stderr: "cancelled",
              exitCode: 1,
              isError: true,
              stdoutTruncated: false,
              stderrTruncated: false,
              fsIsolation: false,
            },
          });
          return;
        }
        write({
          id: req.id,
          ok: true,
          result: {
            stdout: "sidecar-ok\n",
            stderr: "",
            exitCode: 0,
            isError: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            fsIsolation: false,
          },
        });
      } finally {
        inFlight.delete(req.id);
      }
    })();
    continue;
  }
  write({ id: req.id, ok: false, error: `unknown method: ${req.method}` });
}
