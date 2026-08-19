/**
 * Bash validator parity tests (claw-code style).
 *
 * The 200 commands in `bash-commands.ts` are the **parity contract**:
 * any change to a validator that flips a verdict is a regression.
 * This file runs every command through `validateBash()` and asserts
 * the verdict kind matches the expected.
 *
 * **Why one big test per group, not 200 tiny tests?**
 * - 200 individual `it()` calls add 200 names to the test output,
 *   drowning the signal. Grouped output is scannable.
 * - A regression in a single command still gets a clear failure
 *   message ("Group N: command X expected allow, got block").
 * - The fixture is the test list; adding commands doesn't grow
 *   this file.
 *
 * **Direct unit tests** for each individual validator (in
 * addition to the parity run) live in their own describe blocks.
 * Those test edge cases the fixture doesn't cover.
 */

import { describe, expect, it } from "vitest";

import {
  containsBackticks,
  hasUnbalancedQuotes,
  validateBash,
  type BashValidator,
} from "../src/index.js";
import { commandSemanticsValidation } from "../src/permissions/bash/semantics.js";
import { destructiveCommandWarning } from "../src/permissions/bash/destructive-warning.js";
import { modeValidation } from "../src/permissions/bash/mode.js";
import { pathValidation } from "../src/permissions/bash/path.js";
import { readOnlyValidation } from "../src/permissions/bash/read-only.js";
import { sedValidation } from "../src/permissions/bash/sed.js";
import {
  ALL_BASH_COMMANDS,
  inputFromFixture,
  type BashCommandFixture,
} from "./fixtures/bash-commands.js";

import type {
  BashValidationInput,
  BashVerdict,
  SandboxPolicy,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run one fixture row through `validateBash` and assert the kind matches.
 * The full verdict is not asserted (reason text is informational; the
 * kind is the contract). Failing the kind is a regression.
 */
function expectVerdictKind(
  row: BashCommandFixture,
  expected: BashVerdict["kind"],
): void {
  const verdict = validateBash(inputFromFixture(row));
  void expect(verdict).resolves.toEqual(
    expected === "allow"
      ? { kind: "allow" }
      : expected === "block"
        ? expect.objectContaining({ kind: "block" })
        : expect.objectContaining({ kind: expected }),
  );
}

void expectVerdictKind; // satisfy unused-var when below loops are commented out

// ---------------------------------------------------------------------------
// Parity: 200 commands through the composition
// ---------------------------------------------------------------------------

describe("bash parity: validateBash() on the 200-command fixture", () => {
  it("Group 1: read-only-safe commands in read-only mode all allow", async () => {
    for (const row of ALL_BASH_COMMANDS.filter((r) =>
      r.tag.startsWith("g1-"),
    )) {
      const verdict = await validateBash(inputFromFixture(row));
      expect(verdict.kind, `g1 row ${row.tag}: ${row.command}`).toBe(
        "allow",
      );
    }
  });

  it("Group 2: write commands in read-only mode all block", async () => {
    for (const row of ALL_BASH_COMMANDS.filter((r) =>
      r.tag.startsWith("g2-"),
    )) {
      const verdict = await validateBash(inputFromFixture(row));
      expect(verdict.kind, `g2 row ${row.tag}: ${row.command}`).toBe(
        "block",
      );
    }
  });

  it("Group 3: write commands in workspace-write mode all allow", async () => {
    for (const row of ALL_BASH_COMMANDS.filter((r) =>
      r.tag.startsWith("g3-"),
    )) {
      const verdict = await validateBash(inputFromFixture(row));
      expect(verdict.kind, `g3 row ${row.tag}: ${row.command}`).toBe(
        "allow",
      );
    }
  });

  it("Group 4: network commands with networkAccess=false all block", async () => {
    for (const row of ALL_BASH_COMMANDS.filter((r) =>
      r.tag.startsWith("g4-"),
    )) {
      const verdict = await validateBash(inputFromFixture(row));
      expect(verdict.kind, `g4 row ${row.tag}: ${row.command}`).toBe(
        "block",
      );
    }
  });

  it("Group 5: network commands with networkAccess=true all allow", async () => {
    for (const row of ALL_BASH_COMMANDS.filter((r) =>
      r.tag.startsWith("g5-"),
    )) {
      const verdict = await validateBash(inputFromFixture(row));
      expect(verdict.kind, `g5 row ${row.tag}: ${row.command}`).toBe(
        "allow",
      );
    }
  });

  it("Group 6: destructive commands either warn or allow (no block)", async () => {
    for (const row of ALL_BASH_COMMANDS.filter((r) =>
      r.tag.startsWith("g6-"),
    )) {
      const verdict = await validateBash(inputFromFixture(row));
      // The destructive validator warns; the rest of the system
      // doesn't block on this. Either 'allow' or 'allow-with-warning'
      // is acceptable; 'block' would be wrong.
      expect(
        verdict.kind === "allow" || verdict.kind === "allow-with-warning",
        `g6 row ${row.tag}: ${row.command} got ${verdict.kind}`,
      ).toBe(true);
    }
  });

  it("Group 7: sed -i on system path all block", async () => {
    for (const row of ALL_BASH_COMMANDS.filter((r) =>
      r.tag.startsWith("g7-"),
    )) {
      const verdict = await validateBash(inputFromFixture(row));
      expect(verdict.kind, `g7 row ${row.tag}: ${row.command}`).toBe(
        "block",
      );
    }
  });

  it("Group 8: sed -i on user path all allow", async () => {
    for (const row of ALL_BASH_COMMANDS.filter((r) =>
      r.tag.startsWith("g8-"),
    )) {
      const verdict = await validateBash(inputFromFixture(row));
      expect(verdict.kind, `g8 row ${row.tag}: ${row.command}`).toBe(
        "allow",
      );
    }
  });

  it("Group 9: path inside writable_roots in workspace-write all allow", async () => {
    for (const row of ALL_BASH_COMMANDS.filter((r) =>
      r.tag.startsWith("g9-"),
    )) {
      const verdict = await validateBash(inputFromFixture(row));
      expect(verdict.kind, `g9 row ${row.tag}: ${row.command}`).toBe(
        "allow",
      );
    }
  });

  it("Group 10: path outside writable_roots in workspace-write all block", async () => {
    for (const row of ALL_BASH_COMMANDS.filter((r) =>
      r.tag.startsWith("g10-"),
    )) {
      const verdict = await validateBash(inputFromFixture(row));
      expect(verdict.kind, `g10 row ${row.tag}: ${row.command}`).toBe(
        "block",
      );
    }
  });

  it("Group 11: shell injection behaves as the fixture declares", async () => {
    for (const row of ALL_BASH_COMMANDS.filter((r) =>
      r.tag.startsWith("g11-"),
    )) {
      const verdict = await validateBash(inputFromFixture(row));
      expect(verdict.kind, `g11 row ${row.tag}: ${row.command}`).toBe(
        row.expected,
      );
    }
  });

  it("Group 12: edge cases all behave as the fixture declares", async () => {
    for (const row of ALL_BASH_COMMANDS.filter((r) =>
      r.tag.startsWith("g12-"),
    )) {
      const verdict = await validateBash(inputFromFixture(row));
      expect(verdict.kind, `g12 row ${row.tag}: ${row.command}`).toBe(
        row.expected,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Direct unit tests for each validator (edge cases the fixture doesn't cover)
// ---------------------------------------------------------------------------

const READ_ONLY: SandboxPolicy = {
  mode: "read-only",
  approval: "on-request",
  backend: "linux-landlock",
  writableRoots: [],
  networkAccess: true,
  excludeSlashTmp: false,
};

const WORKSPACE_WRITE: SandboxPolicy = {
  mode: "workspace-write",
  approval: "on-request",
  backend: "linux-landlock",
  writableRoots: ["/home/alice/project"],
  networkAccess: false,
  excludeSlashTmp: true,
};

function makeInput(
  command: string,
  argv: ReadonlyArray<string>,
  policy: SandboxPolicy,
  cwd = "/home/alice/project",
): BashValidationInput {
  return { command, argv, env: { PATH: "/usr/bin" }, cwd, policy };
}

describe("readOnlyValidation", () => {
  const v: BashValidator = readOnlyValidation;

  it("returns allow when not in read-only mode (regardless of command)", async () => {
    const input = makeInput("rm -rf /", ["rm", "-rf", "/"], WORKSPACE_WRITE);
    expect(await v.validate(input)).toEqual({ kind: "allow" });
  });

  it("blocks write in read-only mode (echo with redirect)", async () => {
    const input = makeInput("echo hi > /tmp/x", ["echo", "hi"], READ_ONLY);
    const v2 = await v.validate(input);
    expect(v2.kind).toBe("block");
  });

  it("blocks rm in read-only mode", async () => {
    const input = makeInput("rm foo", ["rm", "foo"], READ_ONLY);
    expect((await v.validate(input)).kind).toBe("block");
  });

  it("allows read-only commands in read-only mode", async () => {
    const input = makeInput("ls -la", ["ls", "-la"], READ_ONLY);
    expect(await v.validate(input)).toEqual({ kind: "allow" });
  });
});

describe("readOnlyValidation: redirect + write-verb hardening", () => {
  const v: BashValidator = readOnlyValidation;

  it("blocks no-space redirects", async () => {
    const input = makeInput("echo hi>file", ["echo", "hi>file"], READ_ONLY);
    expect((await v.validate(input)).kind).toBe("block");
  });

  it("blocks fd redirects to real files", async () => {
    const input = makeInput("ls 2>/tmp/out.txt", ["ls"], READ_ONLY);
    expect((await v.validate(input)).kind).toBe("block");
  });

  it("blocks combined &> redirects", async () => {
    const input = makeInput("cmd &>/tmp/out.txt", ["cmd"], READ_ONLY);
    expect((await v.validate(input)).kind).toBe("block");
  });

  it("blocks read-write open <>", async () => {
    const input = makeInput("cmd <>file", ["cmd"], READ_ONLY);
    expect((await v.validate(input)).kind).toBe("block");
  });

  it("allows fd duplication (2>&1, >&2)", async () => {
    const a = makeInput("cmd 2>&1", ["cmd"], READ_ONLY);
    const b = makeInput("cmd >&2", ["cmd"], READ_ONLY);
    expect((await v.validate(a)).kind).toBe("allow");
    expect((await v.validate(b)).kind).toBe("allow");
  });

  it("allows redirects to /dev/null", async () => {
    const a = makeInput("ls 2>/dev/null", ["ls"], READ_ONLY);
    const b = makeInput("cmd > /dev/null", ["cmd"], READ_ONLY);
    expect((await v.validate(a)).kind).toBe("allow");
    expect((await v.validate(b)).kind).toBe("allow");
  });

  it("blocks git mutating commands in read-only", async () => {
    for (const cmd of [
      "git add .",
      "git commit -m msg",
      "git push origin main",
      "git checkout -b feature",
      "git reset --hard HEAD",
    ]) {
      const input = makeInput(cmd, [], READ_ONLY);
      expect((await v.validate(input)).kind, cmd).toBe("block");
    }
  });

  it("allows read-only git commands", async () => {
    for (const cmd of ["git status", "git diff", "git log --oneline -5"]) {
      const input = makeInput(cmd, [], READ_ONLY);
      expect((await v.validate(input)).kind, cmd).toBe("allow");
    }
  });

  it("blocks dd writes and package-manager installs", async () => {
    for (const cmd of [
      "dd if=/dev/zero of=out.bin bs=1M",
      "npm i",
      "yarn add lodash",
      "pnpm install",
      "bun add zod",
    ]) {
      const input = makeInput(cmd, [], READ_ONLY);
      expect((await v.validate(input)).kind, cmd).toBe("block");
    }
  });

  it("matches tee without requiring a trailing space", async () => {
    const input = makeInput("echo hi | tee>out.txt", [], READ_ONLY);
    expect((await v.validate(input)).kind).toBe("block");
  });
});

describe("destructiveCommandWarning", () => {
  const v: BashValidator = destructiveCommandWarning;

  it("warns on rm -rf /", async () => {
    const input = makeInput("rm -rf /", ["rm", "-rf", "/"], WORKSPACE_WRITE);
    const verdict = await v.validate(input);
    expect(verdict.kind).toBe("allow-with-warning");
    if (verdict.kind === "allow-with-warning") {
      expect(verdict.warning).toMatch(/destructive/);
    }
  });

  it("allows non-destructive commands", async () => {
    const input = makeInput("ls", ["ls"], WORKSPACE_WRITE);
    expect(await v.validate(input)).toEqual({ kind: "allow" });
  });

  it("warns on dd to /dev", async () => {
    const input = makeInput(
      "dd if=/dev/zero of=/dev/sda",
      ["dd", "if=/dev/zero", "of=/dev/sda"],
      WORKSPACE_WRITE,
    );
    const verdict = await v.validate(input);
    expect(verdict.kind).toBe("allow-with-warning");
  });
});

describe("modeValidation", () => {
  const v: BashValidator = modeValidation;

  it("blocks curl when networkAccess is false", async () => {
    const input = makeInput(
      "curl https://example.com",
      ["curl", "https://example.com"],
      WORKSPACE_WRITE,
    );
    const verdict = await v.validate(input);
    expect(verdict.kind).toBe("block");
  });

  it("allows curl when networkAccess is true", async () => {
    const policy: SandboxPolicy = { ...WORKSPACE_WRITE, networkAccess: true };
    const input = makeInput(
      "curl https://example.com",
      ["curl", "https://example.com"],
      policy,
    );
    expect(await v.validate(input)).toEqual({ kind: "allow" });
  });

  it("blocks ssh when networkAccess is false", async () => {
    const input = makeInput("ssh user@host", ["ssh", "user@host"], WORKSPACE_WRITE);
    expect((await v.validate(input)).kind).toBe("block");
  });
});

describe("sedValidation", () => {
  const v: BashValidator = sedValidation;

  it("blocks sed -i on /etc/hosts", async () => {
    const input = makeInput(
      "sed -i 's/a/b/' /etc/hosts",
      ["sed", "-i", "s/a/b/", "/etc/hosts"],
      WORKSPACE_WRITE,
    );
    expect((await v.validate(input)).kind).toBe("block");
  });

  it("allows sed -i on user paths", async () => {
    const input = makeInput(
      "sed -i 's/a/b/' file.txt",
      ["sed", "-i", "s/a/b/", "file.txt"],
      WORKSPACE_WRITE,
    );
    expect(await v.validate(input)).toEqual({ kind: "allow" });
  });

  it("allows sed without -i flag", async () => {
    const input = makeInput(
      "sed 's/a/b/' /etc/hosts",
      ["sed", "s/a/b/", "/etc/hosts"],
      WORKSPACE_WRITE,
    );
    expect(await v.validate(input)).toEqual({ kind: "allow" });
  });
});

describe("pathValidation", () => {
  const v: BashValidator = pathValidation;

  it("returns allow in read-only mode (no path check)", async () => {
    const input = makeInput("rm /etc/x", ["rm", "/etc/x"], READ_ONLY);
    expect(await v.validate(input)).toEqual({ kind: "allow" });
  });

  it("blocks path outside writable_roots in workspace-write", async () => {
    const input = makeInput("rm /etc/foo", ["rm", "/etc/foo"], WORKSPACE_WRITE);
    const verdict = await v.validate(input);
    expect(verdict.kind).toBe("block");
  });

  it("allows path inside writable_roots in workspace-write", async () => {
    const input = makeInput(
      "rm /home/alice/project/foo",
      ["rm", "/home/alice/project/foo"],
      WORKSPACE_WRITE,
    );
    expect(await v.validate(input)).toEqual({ kind: "allow" });
  });

  it("falls back to cwd when writable_roots is empty", async () => {
    const policy: SandboxPolicy = { ...WORKSPACE_WRITE, writableRoots: [] };
    const input = makeInput(
      "rm ./foo",
      ["rm", "./foo"],
      policy,
      "/tmp",
    );
    expect(await v.validate(input)).toEqual({ kind: "allow" });
  });

  it("blocks `~/foo` when the home dir is outside writable_roots", async () => {
    // writable_roots is /home/alice/project; on this machine, os.homedir()
    // is /Users/shileipeng. So `~/foo` expands to /Users/shileipeng/foo,
    // which is outside writable_roots. The validator should block.
    const input = makeInput(
      "rm ~/foo",
      ["rm", "~/foo"],
      WORKSPACE_WRITE,
    );
    const verdict = await v.validate(input);
    expect(verdict.kind).toBe("block");
  });

  it("allows `~/foo` when the home dir is inside writable_roots", async () => {
    // Make writable_roots include the user's actual home directory.
    const home = (await import("node:os")).homedir();
    const policy: SandboxPolicy = {
      ...WORKSPACE_WRITE,
      writableRoots: [home],
    };
    const input = makeInput("rm ~/foo", ["rm", "~/foo"], policy);
    expect(await v.validate(input)).toEqual({ kind: "allow" });
  });

  it("blocks relative paths that escape writable_roots", async () => {
    const input = makeInput(
      "rm -rf ../secret",
      ["rm", "-rf", "../secret"],
      WORKSPACE_WRITE,
    );
    expect((await v.validate(input)).kind).toBe("block");
  });

  it("blocks `..` (parent directory) in workspace-write", async () => {
    const input = makeInput("cd ..", ["cd", ".."], WORKSPACE_WRITE);
    expect((await v.validate(input)).kind).toBe("block");
  });

  it("allows relative paths that resolve inside writable_roots", async () => {
    const input = makeInput(
      "sed -i s/a/b/ ../project/file.txt",
      ["sed", "-i", "s/a/b/", "../project/file.txt"],
      WORKSPACE_WRITE,
      "/home/alice/project/sub",
    );
    expect((await v.validate(input)).kind).toBe("allow");
  });

  it("is boundary-aware (sibling of a root is outside)", async () => {
    const input = makeInput(
      "rm /home/alice/project2/x",
      ["rm", "/home/alice/project2/x"],
      WORKSPACE_WRITE,
    );
    expect((await v.validate(input)).kind).toBe("block");
  });

  it("skips flag-like tokens", async () => {
    const input = makeInput(
      "find /home/alice/project -name '*.ts'",
      ["find", "/home/alice/project", "-name", "*.ts"],
      WORKSPACE_WRITE,
    );
    expect((await v.validate(input)).kind).toBe("allow");
  });
});

describe("commandSemanticsValidation", () => {
  const v: BashValidator = commandSemanticsValidation;

  it("blocks unbalanced double quotes", async () => {
    const input = makeInput('echo "hello', ["echo"], READ_ONLY);
    expect((await v.validate(input)).kind).toBe("block");
  });

  it("blocks unbalanced single quotes", async () => {
    const input = makeInput("echo 'hello", ["echo"], READ_ONLY);
    expect((await v.validate(input)).kind).toBe("block");
  });

  it("blocks backticks", async () => {
    const input = makeInput("echo `date`", ["echo", "`date`"], READ_ONLY);
    expect((await v.validate(input)).kind).toBe("block");
  });

  it("allows balanced quotes", async () => {
    const input = makeInput('echo "hi"', ["echo", '"hi"'], READ_ONLY);
    expect(await v.validate(input)).toEqual({ kind: "allow" });
  });
});

describe("helper functions", () => {
  describe("hasUnbalancedQuotes", () => {
    it("returns true for odd number of single quotes", () => {
      expect(hasUnbalancedQuotes("echo 'hi")).toBe(true);
    });

    it("returns true for odd number of double quotes", () => {
      expect(hasUnbalancedQuotes('echo "hi')).toBe(true);
    });

    it("returns false for balanced quotes", () => {
      expect(hasUnbalancedQuotes('echo "hi"')).toBe(false);
    });

    it("returns false for no quotes", () => {
      expect(hasUnbalancedQuotes("ls -la")).toBe(false);
    });

    it("returns false for an even mix", () => {
      expect(hasUnbalancedQuotes(`echo "a" 'b'`)).toBe(false);
    });

    it("returns false for escaped quotes (backslash)", () => {
      expect(hasUnbalancedQuotes(`echo a\\"b`)).toBe(false);
    });

    it("returns false for an apostrophe inside double quotes", () => {
      expect(hasUnbalancedQuotes(`echo "it's"`)).toBe(false);
    });

    it("returns true for an unclosed quote after an escape", () => {
      expect(hasUnbalancedQuotes('echo "a\\"')).toBe(true);
    });
  });

  describe("containsBackticks", () => {
    it("returns true when backticks present", () => {
      expect(containsBackticks("echo `date`")).toBe(true);
    });

    it("returns false when no backticks", () => {
      expect(containsBackticks("echo $(date)")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(containsBackticks("")).toBe(false);
    });
  });
});

describe("validateBash composition", () => {
  it("is idempotent: same input returns same verdict", async () => {
    const input = makeInput("ls -la", ["ls", "-la"], READ_ONLY);
    const a = await validateBash(input);
    const b = await validateBash(input);
    expect(a).toEqual(b);
  });

  it("first block short-circuits (does not surface warnings)", async () => {
    // A command that's both blocked (unbalanced quotes) and would
    // warn (rm -rf /): the block wins, the user doesn't see the warning.
    const input = makeInput(
      'rm -rf / "unbalanced',
      ["rm", "-rf", "/"],
      DESTRUCTIVE_POLICY,
    );
    const verdict = await validateBash(input);
    expect(verdict.kind).toBe("block");
  });

  it("first warning wins when no blocks", async () => {
    // rm -rf / in danger-full-access: the destructive validator warns.
    // No other validator should block or warn on this. Verdict should
    // be allow-with-warning.
    const input = makeInput("rm -rf /", ["rm", "-rf", "/"], DESTRUCTIVE_POLICY);
    const verdict = await validateBash(input);
    expect(verdict.kind).toBe("allow-with-warning");
  });

  it("allow when no validator fires", async () => {
    const input = makeInput("ls -la", ["ls", "-la"], READ_ONLY);
    expect(await validateBash(input)).toEqual({ kind: "allow" });
  });
});

const DESTRUCTIVE_POLICY: SandboxPolicy = {
  mode: "danger-full-access",
  approval: "never",
  backend: "none",
  writableRoots: [],
  networkAccess: true,
  excludeSlashTmp: false,
};
