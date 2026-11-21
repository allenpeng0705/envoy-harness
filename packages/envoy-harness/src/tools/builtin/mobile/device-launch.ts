/**
 * device_launch — launch by bundle id / Android activity.
 */

import { z } from "zod";

import type { Tool } from "../../types.js";
import { runHostCommand } from "./exec.js";
import { requireMobileAccess } from "./gate.js";

const params = z.object({
  platform: z.enum(["ios", "android"]),
  device_id: z.string().min(1),
  app_id: z
    .string()
    .min(1)
    .describe("iOS bundle id, or Android package[/activity]"),
});

export const deviceLaunchTool: Tool<typeof params> = {
  name: "device_launch",
  timeoutMs: 60_000,
  description:
    "Launch an installed app: iOS via `simctl launch <udid> <bundleId>`, " +
    "Android via `adb shell am start` / monkey for package-only.",
  parameters: params,
  async execute(args, ctx) {
    const denied = requireMobileAccess(ctx);
    if (denied) return denied;

    if (args.platform === "ios") {
      const result = await runHostCommand(
        ["xcrun", "simctl", "launch", args.device_id, args.app_id],
        { signal: ctx.abortSignal, timeoutMs: 45_000 },
      );
      if (result.error) return { content: result.error, isError: true };
      if ((result.code ?? 1) !== 0) {
        return {
          content: `simctl launch failed: ${result.stderr || result.stdout}`,
          isError: true,
        };
      }
      return {
        content: result.stdout.trim() || `Launched ${args.app_id} on iOS`,
      };
    }

    const hasActivity = args.app_id.includes("/");
    const argv = hasActivity
      ? [
          "adb",
          "-s",
          args.device_id,
          "shell",
          "am",
          "start",
          "-n",
          args.app_id,
        ]
      : [
          "adb",
          "-s",
          args.device_id,
          "shell",
          "monkey",
          "-p",
          args.app_id,
          "-c",
          "android.intent.category.LAUNCHER",
          "1",
        ];
    const result = await runHostCommand(argv, {
      signal: ctx.abortSignal,
      timeoutMs: 45_000,
    });
    if (result.error) return { content: result.error, isError: true };
    if ((result.code ?? 1) !== 0) {
      return {
        content: `adb launch failed: ${result.stderr || result.stdout}`,
        isError: true,
      };
    }
    return {
      content: result.stdout.trim() || `Launched ${args.app_id} on Android`,
    };
  },
};
