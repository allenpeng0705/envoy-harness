/**
 * device_list — list iOS simulators + Android devices/emulators.
 */

import { z } from "zod";

import type { Tool } from "../../types.js";
import { runHostCommand } from "./exec.js";
import { requireMobileAccess } from "./gate.js";

const params = z.object({
  platform: z
    .enum(["all", "ios", "android"])
    .optional()
    .describe("Filter platform (default all)"),
});

export const deviceListTool: Tool<typeof params> = {
  name: "device_list",
  timeoutMs: 60_000,
  isConcurrencySafe: () => true,
  description:
    "List available mobile devices: iOS simulators (xcrun simctl) and " +
    "Android devices/emulators (adb). Requires mobile permission preset.",
  parameters: params,
  async execute(args, ctx) {
    const denied = requireMobileAccess(ctx);
    if (denied) return denied;
    const platform = args.platform ?? "all";
    const sections: string[] = [];

    if (platform === "all" || platform === "ios") {
      const ios = await runHostCommand(
        ["xcrun", "simctl", "list", "devices", "--json"],
        { signal: ctx.abortSignal, timeoutMs: 45_000 },
      );
      if (ios.error) {
        sections.push(`iOS: ${ios.error}`);
      } else if ((ios.code ?? 1) !== 0) {
        sections.push(
          `iOS: simctl failed (code ${ios.code}): ${ios.stderr || ios.stdout}`,
        );
      } else {
        sections.push(`iOS simulators (simctl JSON):\n${ios.stdout.trim()}`);
      }
    }

    if (platform === "all" || platform === "android") {
      const adb = await runHostCommand(["adb", "devices", "-l"], {
        signal: ctx.abortSignal,
        timeoutMs: 30_000,
      });
      if (adb.error) {
        sections.push(`Android: ${adb.error}`);
      } else if ((adb.code ?? 1) !== 0) {
        sections.push(
          `Android: adb failed (code ${adb.code}): ${adb.stderr || adb.stdout}`,
        );
      } else {
        sections.push(`Android devices (adb):\n${adb.stdout.trim()}`);
      }
    }

    return { content: sections.join("\n\n") };
  },
};
