import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/argv.js";
import { parseConfigPatchFragment } from "../src/cli/run/config-patch.js";
import {
  createConfigProfileLoader,
  profileAsOverrides,
} from "../src/cli/run/profile-loader.js";
import {
  resetShellInvocationCache,
  resolveShellInvocation,
} from "../src/tools/shell-invocation.js";

describe("cli ops wave1", () => {
  it("parses config dump argv", () => {
    const a = parseArgs(["config", "dump", "--json", "--effective"]);
    expect(a.subcommand).toBe("config");
    if (a.subcommand !== "config") return;
    expect(a.json).toBe(true);
    expect(a.effective).toBe(true);
  });

  it("parses --config-patch and --profile on run", () => {
    const a = parseArgs([
      "--config-patch",
      '{"permissionMode":"read-only"}',
      "--profile",
      "dev",
    ]);
    expect(a.subcommand).toBe("run");
    if (a.subcommand !== "run") return;
    expect(a.configPatch).toContain("permissionMode");
    expect(a.profile).toBe("dev");
  });

  it("parses config-patch JSON fragment", () => {
    const layer = parseConfigPatchFragment(
      '{"permissionMode":"workspace-write"}',
    );
    expect(layer.permissionMode).toBe("workspace-write");
  });

  it("loads profiles from config layer", () => {
    const loader = createConfigProfileLoader({
      profiles: {
        safe: { sandbox: "read-only", approval: "on-request" },
      },
    });
    expect(loader.list()).toEqual(["safe"]);
    expect(loader.get("safe")?.sandbox).toBe("read-only");
    expect(loader.get("missing")).toBeNull();
  });

  it("profileAsOverrides maps sandbox/approval only", () => {
    expect(
      profileAsOverrides({
        sandbox: "read-only",
        approval: "on-request",
        model: "gpt-test",
      }),
    ).toEqual({
      permissionMode: "read-only",
      askForApproval: "on-request",
    });
    expect(profileAsOverrides(null)).toEqual({});
  });

  it("forwards --config-patch/--profile on web subcommand", () => {
    const a = parseArgs([
      "web",
      "--config-patch",
      '{"permissionMode":"read-only"}',
      "--profile",
      "safe",
    ]);
    expect(a.subcommand).toBe("web");
  });

  it("resolves POSIX shell to sh -c", () => {
    const inv = resolveShellInvocation("linux", "echo hi");
    expect(inv.kind).toBe("sh");
    expect(inv.file).toBe("sh");
    expect(inv.args).toEqual(["-c", "echo hi"]);
  });

  it("resolves win32 shell to pwsh or powershell", () => {
    resetShellInvocationCache();
    const inv = resolveShellInvocation("win32", "echo hi");
    expect(inv.kind === "pwsh" || inv.kind === "powershell").toBe(true);
    expect(inv.args.at(-1)).toBe("echo hi");
  });
});
