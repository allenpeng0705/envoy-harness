/**
 * device_boot — boot or shutdown a simulator / emulator by id.
 */

import { z } from "zod";

import type { Tool } from "../../types.js";
import { runHostCommand } from "./exec.js";
import { requireMobileAccess } from "./gate.js";

const params = z.object({
  platform: z.enum(["ios", "android"]).describe("Target platform"),
  device_id: z
    .string()
    .min(1)
    .describe("iOS UDID, Android serial (emulator-5554), or AVD name"),
  action: z
    .enum(["boot", "shutdown"])
    .optional()
    .describe("boot (default) or shutdown"),
  wait_ready: z
    .boolean()
    .optional()
    .describe("Wait until the device reports ready (default true for boot)"),
});

/** ADB serials look like `emulator-5554` or `1A2B3C4D`; AVD names do not. */
function looksLikeAdbSerial(id: string): boolean {
  return /[:.]/.test(id) || /^emulator-\d+$/i.test(id) || /^[0-9A-Fa-f]{6,}$/.test(id);
}

async function listAdbSerials(
  signal: AbortSignal,
): Promise<string[]> {
  const listed = await runHostCommand(["adb", "devices"], {
    signal,
    timeoutMs: 30_000,
  });
  if (listed.error || (listed.code ?? 1) !== 0) return [];
  const serials: string[] = [];
  for (const line of listed.stdout.split("\n")) {
    const m = /^(\S+)\s+(device|offline|unauthorized)\b/.exec(line.trim());
    if (m && m[1] !== "List") serials.push(m[1]!);
  }
  return serials;
}

async function waitAndroidBootCompleted(
  serial: string,
  signal: AbortSignal,
  timeoutMs = 180_000,
): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) {
      return { ok: false, detail: "aborted while waiting for boot_completed" };
    }
    const prop = await runHostCommand(
      ["adb", "-s", serial, "shell", "getprop", "sys.boot_completed"],
      { signal, timeoutMs: 15_000 },
    );
    const value = (prop.stdout || "").trim();
    if (value === "1") {
      return { ok: true, detail: `sys.boot_completed=1 on ${serial}` };
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return {
    ok: false,
    detail: `timed out waiting for sys.boot_completed on ${serial}`,
  };
}

export const deviceBootTool: Tool<typeof params> = {
  name: "device_boot",
  timeoutMs: 300_000,
  description:
    "Boot or shutdown an iOS Simulator (simctl) or Android emulator/device (adb). " +
    "Optionally wait until ready. Use device_list to discover ids.",
  parameters: params,
  async execute(args, ctx) {
    const denied = requireMobileAccess(ctx);
    if (denied) return denied;
    const action = args.action ?? "boot";
    const wait = args.wait_ready ?? action === "boot";

    if (args.platform === "ios") {
      const op = action === "boot" ? "boot" : "shutdown";
      const result = await runHostCommand(
        ["xcrun", "simctl", op, args.device_id],
        { signal: ctx.abortSignal, timeoutMs: 120_000 },
      );
      if (result.error) {
        return { content: result.error, isError: true };
      }
      // simctl boot returns non-zero if already booted — treat as ok.
      const already =
        /Unable to boot device in current state: Booted/i.test(result.stderr) ||
        /Unable to boot device in current state: Booted/i.test(result.stdout);
      if ((result.code ?? 1) !== 0 && !already) {
        return {
          content: `simctl ${op} failed: ${result.stderr || result.stdout}`,
          isError: true,
        };
      }
      if (wait && action === "boot") {
        const ready = await runHostCommand(
          ["xcrun", "simctl", "bootstatus", args.device_id, "-b"],
          { signal: ctx.abortSignal, timeoutMs: 180_000 },
        );
        if (ready.error || (ready.code ?? 1) !== 0) {
          return {
            content: `booted but wait-ready failed: ${ready.error ?? ready.stderr ?? ready.stdout}`,
            isError: true,
          };
        }
        return { content: `iOS simulator ${args.device_id} booted and ready` };
      }
      return { content: `iOS simulator ${args.device_id}: ${op} ok` };
    }

    // Android
    if (action === "shutdown") {
      const serial = looksLikeAdbSerial(args.device_id)
        ? args.device_id
        : undefined;
      if (serial !== undefined) {
        const result = await runHostCommand(
          ["adb", "-s", serial, "emu", "kill"],
          { signal: ctx.abortSignal, timeoutMs: 60_000 },
        );
        if (result.error) return { content: result.error, isError: true };
        return {
          content: `Android ${serial}: shutdown requested (code ${result.code})`,
        };
      }
      // AVD name — best-effort kill of the only online emulator.
      const serials = await listAdbSerials(ctx.abortSignal);
      const emu = serials.find((s) => s.startsWith("emulator-"));
      if (emu === undefined) {
        return {
          content: `No emulator serial found to shut down for AVD ${args.device_id}`,
          isError: true,
        };
      }
      const result = await runHostCommand(["adb", "-s", emu, "emu", "kill"], {
        signal: ctx.abortSignal,
        timeoutMs: 60_000,
      });
      if (result.error) return { content: result.error, isError: true };
      return {
        content: `Android ${emu} (AVD ${args.device_id}): shutdown requested`,
      };
    }

    const before = new Set(await listAdbSerials(ctx.abortSignal));
    let serial = looksLikeAdbSerial(args.device_id) ? args.device_id : undefined;

    if (serial === undefined) {
      // Cold-boot AVD by name — detach so the 5s settle does not SIGTERM it.
      const boot = await runHostCommand(
        ["emulator", "-avd", args.device_id, "-no-snapshot-load"],
        {
          signal: ctx.abortSignal,
          timeoutMs: 3_000,
          detach: true,
        },
      );
      if (boot.error?.includes("command not found")) {
        return { content: boot.error, isError: true };
      }
    }

    if (wait) {
      // Resolve serial: prefer known id, else first new emulator-*, else any.
      const deadline = Date.now() + 180_000;
      while (serial === undefined && Date.now() < deadline) {
        if (ctx.abortSignal.aborted) {
          return { content: "aborted while waiting for emulator serial", isError: true };
        }
        const now = await listAdbSerials(ctx.abortSignal);
        const fresh = now.find(
          (s) => s.startsWith("emulator-") && !before.has(s),
        );
        serial = fresh ?? now.find((s) => s.startsWith("emulator-"));
        if (serial === undefined) {
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
      if (serial === undefined) {
        return {
          content:
            "Android emulator started but no adb serial appeared. " +
            "Check `adb devices` / ANDROID_HOME.",
          isError: true,
        };
      }

      const ready = await runHostCommand(
        ["adb", "-s", serial, "wait-for-device"],
        { signal: ctx.abortSignal, timeoutMs: 180_000 },
      );
      if (ready.error || (ready.code ?? 1) !== 0) {
        return {
          content: `adb wait-for-device failed for ${serial}: ${ready.error ?? ready.stderr}`,
          isError: true,
        };
      }
      const boot = await waitAndroidBootCompleted(serial, ctx.abortSignal);
      if (!boot.ok) {
        return { content: boot.detail, isError: true };
      }
      return {
        content: `Android device ${serial} ready (${boot.detail})`,
      };
    }

    return {
      content: serial
        ? `Android device ${serial}: boot requested`
        : `Android AVD ${args.device_id}: boot requested`,
    };
  },
};
