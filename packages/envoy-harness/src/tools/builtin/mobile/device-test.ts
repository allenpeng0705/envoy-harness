/**
 * device_test — thin wrapper around common mobile UI/unit test runners.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import type { Tool } from "../../types.js";
import { runHostCommand } from "./exec.js";
import { requireMobileAccess } from "./gate.js";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const params = z.object({
  runner: z
    .enum([
      "xcodebuild",
      "flutter",
      "gradle",
      "maestro",
      "detox",
      "auto",
    ])
    .optional()
    .describe("Test runner (default auto from project files)"),
  device_id: z.string().optional().describe("Target device when applicable"),
  scheme: z.string().optional().describe("Xcode scheme (xcodebuild)"),
  project_path: z
    .string()
    .optional()
    .describe("Project / workspace root (default: cwd)"),
  extra_args: z
    .array(z.string())
    .optional()
    .describe("Extra CLI args appended to the runner"),
});

export const deviceTestTool: Tool<typeof params> = {
  name: "device_test",
  timeoutMs: 0, // long UI tests — jobs/PTY preferred for multi-hour; allow unbounded here
  description:
    "Run mobile tests: xcodebuild test, flutter test, gradle connectedAndroidTest, " +
    "Maestro, or Detox when present. Prefer background jobs for very long suites.",
  parameters: params,
  async execute(args, ctx) {
    const denied = requireMobileAccess(ctx);
    if (denied) return denied;
    const cwd = args.project_path ?? ctx.cwd;
    const extra = args.extra_args ?? [];
    let runner = args.runner ?? "auto";

    if (runner === "auto") {
      if (await exists(path.join(cwd, "pubspec.yaml"))) runner = "flutter";
      else if (await exists(path.join(cwd, "ios"))) runner = "xcodebuild";
      else if (
        (await exists(path.join(cwd, "android", "app", "build.gradle"))) ||
        (await exists(path.join(cwd, "android", "app", "build.gradle.kts")))
      )
        runner = "gradle";
      else if (await exists(path.join(cwd, ".maestro"))) runner = "maestro";
      else {
        return {
          content:
            "Could not auto-detect runner. Pass runner: xcodebuild | flutter | gradle | maestro | detox",
          isError: true,
        };
      }
    }

    let argv: string[];
    switch (runner) {
      case "flutter":
        argv = ["flutter", "test", ...extra];
        break;
      case "xcodebuild": {
        const scheme = args.scheme ?? "Runner";
        const dest = args.device_id
          ? `platform=iOS Simulator,id=${args.device_id}`
          : "platform=iOS Simulator,name=iPhone 16";
        argv = [
          "xcodebuild",
          "test",
          "-scheme",
          scheme,
          "-destination",
          dest,
          ...extra,
        ];
        break;
      }
      case "gradle":
        argv = [
          process.platform === "win32" ? "gradlew.bat" : "./gradlew",
          "connectedDebugAndroidTest",
          ...extra,
        ];
        break;
      case "maestro":
        argv = ["maestro", "test", ...extra];
        break;
      case "detox":
        argv = ["npx", "detox", "test", ...extra];
        break;
      default:
        return { content: `unknown runner: ${runner}`, isError: true };
    }

    const result = await runHostCommand(argv, {
      cwd,
      signal: ctx.abortSignal,
      timeoutMs: 600_000,
    });
    if (result.error) return { content: result.error, isError: true };
    const body = [
      `$ ${argv.join(" ")}`,
      result.stdout.trim(),
      result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
      `exit: ${result.code}`,
    ]
      .filter((s) => s.length > 0)
      .join("\n\n");
    return { content: body, isError: (result.code ?? 1) !== 0 };
  },
};
