/**
 * device_install — install .app / .apk / Flutter/RN build artifacts.
 */

import { z } from "zod";

import type { Tool } from "../../types.js";
import { runHostCommand } from "./exec.js";
import { requireMobileAccess } from "./gate.js";

const params = z.object({
  platform: z.enum(["ios", "android", "flutter", "auto"]).optional(),
  device_id: z.string().min(1).describe("Simulator UDID or adb serial"),
  path: z.string().min(1).describe("Path to .app, .apk, or project dir"),
});

export const deviceInstallTool: Tool<typeof params> = {
  name: "device_install",
  timeoutMs: 300_000,
  description:
    "Install an app artifact on a device: iOS .app via simctl, Android .apk via adb, " +
    "or Flutter via `flutter install`. Pass the artifact or project path.",
  parameters: params,
  async execute(args, ctx) {
    const denied = requireMobileAccess(ctx);
    if (denied) return denied;
    const platform =
      args.platform ??
      (args.path.endsWith(".apk")
        ? "android"
        : args.path.endsWith(".app")
          ? "ios"
          : "auto");

    if (platform === "flutter" || (platform === "auto" && !args.path.endsWith(".apk") && !args.path.endsWith(".app"))) {
      const flutter = await runHostCommand(
        ["flutter", "install", "-d", args.device_id],
        { cwd: args.path, signal: ctx.abortSignal, timeoutMs: 240_000 },
      );
      if (flutter.error) return { content: flutter.error, isError: true };
      if ((flutter.code ?? 1) !== 0) {
        // Fall through to platform install if flutter missing / failed on auto.
        if (platform === "flutter") {
          return {
            content: `flutter install failed: ${flutter.stderr || flutter.stdout}`,
            isError: true,
          };
        }
      } else {
        return { content: flutter.stdout.trim() || "flutter install ok" };
      }
    }

    if (platform === "ios" || args.path.endsWith(".app")) {
      const result = await runHostCommand(
        ["xcrun", "simctl", "install", args.device_id, args.path],
        { signal: ctx.abortSignal, timeoutMs: 180_000 },
      );
      if (result.error) return { content: result.error, isError: true };
      if ((result.code ?? 1) !== 0) {
        return {
          content: `simctl install failed: ${result.stderr || result.stdout}`,
          isError: true,
        };
      }
      return { content: `Installed ${args.path} on iOS ${args.device_id}` };
    }

    const result = await runHostCommand(
      ["adb", "-s", args.device_id, "install", "-r", args.path],
      { signal: ctx.abortSignal, timeoutMs: 180_000 },
    );
    if (result.error) return { content: result.error, isError: true };
    if ((result.code ?? 1) !== 0) {
      return {
        content: `adb install failed: ${result.stderr || result.stdout}`,
        isError: true,
      };
    }
    return { content: `Installed ${args.path} on Android ${args.device_id}` };
  },
};
