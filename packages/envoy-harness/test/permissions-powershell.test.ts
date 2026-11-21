import { describe, expect, it } from "vitest";
import { policyFromMode } from "../src/permissions/policy.js";
import {
  tokenizePowerShellCommand,
  validatePowerShell,
} from "../src/permissions/powershell/index.js";
import { validateShellCommand } from "../src/permissions/shell.js";

const cwd = "/tmp/proj";
const env = {};

describe("powershell validators", () => {
  it("tokenizes quoted args", () => {
    expect(tokenizePowerShellCommand(`Get-ChildItem -Path "C:\\a b"`)).toEqual([
      "Get-ChildItem",
      "-Path",
      "C:\\a b",
    ]);
  });

  it("blocks writes in read-only mode", async () => {
    const v = await validatePowerShell({
      command: "Set-Content -Path out.txt -Value hi",
      argv: [],
      env,
      cwd,
      policy: policyFromMode("read-only", cwd),
    });
    expect(v.kind).toBe("block");
  });

  it("allows Get-ChildItem in read-only", async () => {
    const v = await validatePowerShell({
      command: "Get-ChildItem",
      argv: [],
      env,
      cwd,
      policy: policyFromMode("read-only", cwd),
    });
    expect(v.kind).toBe("allow");
  });

  it("blocks network when disabled", async () => {
    const v = await validatePowerShell({
      command: "Invoke-WebRequest https://example.com",
      argv: [],
      env,
      cwd,
      policy: {
        ...policyFromMode("workspace-write", cwd),
        networkAccess: false,
      },
    });
    expect(v.kind).toBe("block");
  });

  it("warns on Remove-Item -Recurse", async () => {
    const v = await validatePowerShell({
      command: "Remove-Item -Recurse C:\\temp\\junk",
      argv: [],
      env,
      cwd,
      policy: policyFromMode("danger-full-access", cwd),
    });
    expect(v.kind).toBe("allow-with-warning");
  });

  it("validateShellCommand routes pwsh vs sh", async () => {
    const ps = await validateShellCommand("pwsh", {
      command: "Set-Content x.txt hi",
      env,
      cwd,
      policy: policyFromMode("read-only", cwd),
    });
    expect(ps.kind).toBe("block");

    const sh = await validateShellCommand("sh", {
      command: "echo hi",
      env,
      cwd,
      policy: policyFromMode("read-only", cwd),
    });
    expect(sh.kind).toBe("allow");
  });
});
