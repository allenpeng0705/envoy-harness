/**
 * device_ui_tree — best-effort accessibility / UI dump.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

import type { Tool } from "../../types.js";
import { runHostCommand } from "./exec.js";
import { requireMobileAccess } from "./gate.js";

const params = z.object({
  platform: z.enum(["ios", "android"]),
  device_id: z.string().min(1),
});

export const deviceUiTreeTool: Tool<typeof params> = {
  name: "device_ui_tree",
  timeoutMs: 90_000,
  isConcurrencySafe: () => true,
  description:
    "Best-effort UI / accessibility tree dump. Android: `uiautomator dump`. " +
    "iOS: tries `idb ui describe-all` when installed, else reports how to install idb.",
  parameters: params,
  async execute(args, ctx) {
    const denied = requireMobileAccess(ctx);
    if (denied) return denied;

    if (args.platform === "android") {
      const remote = "/sdcard/envoy-window_dump.xml";
      const dump = await runHostCommand(
        [
          "adb",
          "-s",
          args.device_id,
          "shell",
          "uiautomator",
          "dump",
          remote,
        ],
        { signal: ctx.abortSignal, timeoutMs: 60_000 },
      );
      if (dump.error) return { content: dump.error, isError: true };
      if ((dump.code ?? 1) !== 0) {
        return {
          content: `uiautomator dump failed: ${dump.stderr || dump.stdout}`,
          isError: true,
        };
      }
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-ui-"));
      const local = path.join(tmp, "dump.xml");
      try {
        const pull = await runHostCommand(
          ["adb", "-s", args.device_id, "pull", remote, local],
          { signal: ctx.abortSignal, timeoutMs: 30_000 },
        );
        if (pull.error || (pull.code ?? 1) !== 0) {
          return {
            content: `adb pull failed: ${pull.error ?? pull.stderr}`,
            isError: true,
          };
        }
        const xml = await fs.readFile(local, "utf8");
        return { content: xml.slice(0, 200_000) };
      } finally {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    // iOS — prefer idb when present
    const idb = await runHostCommand(
      ["idb", "ui", "describe-all", "--udid", args.device_id, "--json"],
      { signal: ctx.abortSignal, timeoutMs: 60_000 },
    );
    if (!idb.error && (idb.code ?? 1) === 0) {
      return { content: idb.stdout.slice(0, 200_000) };
    }
    if (idb.error?.includes("command not found")) {
      return {
        content:
          "iOS UI tree requires `idb` (facebook idb). Install with " +
          "`brew tap facebook/fb && brew install idb-companion idb` " +
          "or use device_screenshot + XCUITest via device_test.",
        isError: true,
      };
    }
    return {
      content: `idb ui describe-all failed: ${idb.error ?? idb.stderr ?? idb.stdout}`,
      isError: true,
    };
  },
};
