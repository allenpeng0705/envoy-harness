import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/argv.js";
import { applyPowerFeatureFlags } from "../src/cli/run/power-flags.js";
import { buildBuiltinRegistry } from "../src/cli/repl/builtin-registry.js";
import type { Agent } from "../src/agent.js";

describe("power feature flags", () => {
  it("parses --power and individual flags", () => {
    const a = parseArgs(["--power", "--no-goals"]);
    expect(a.subcommand).toBe("run");
    if (a.subcommand !== "run") return;
    expect(a.power).toBe(true);
    expect(a.goals).toBe(false);
  });

  it("applyPowerFeatureFlags enables schedule/goals/present by default for REPL", () => {
    const opts: Parameters<typeof applyPowerFeatureFlags>[0] = {
      model: {} as never,
      tools: {} as never,
      session: {} as never,
    };
    applyPowerFeatureFlags(
      opts,
      {
        runCode: false,
        codeMode: false,
        toolSearch: false,
        schedule: undefined,
        goals: undefined,
        present: undefined,
        power: false,
      },
      { scheduleGoalsPresent: true },
    );
    expect(opts.enableSchedule).toBe(true);
    expect(opts.enableGoals).toBe(true);
    expect(opts.enablePresent).toBe(true);
    expect(opts.enableRunCode).toBeUndefined();
  });

  it("registers /schedule and /goals slash commands", () => {
    const reg = buildBuiltinRegistry();
    expect(reg.lookup("/schedule")?.name).toBe("/schedule");
    expect(reg.lookup("/goals")?.name).toBe("/goals");
  });

  it("/schedule list handles empty agent", async () => {
    const reg = buildBuiltinRegistry();
    const cmd = reg.lookup("/schedule")!;
    const lines: string[] = [];
    await cmd.handler(["list"], {
      agent: {
        listSchedules: () => [],
        tools: { has: () => true },
      } as unknown as Agent,
      args: {} as never,
      stdout: { write: (s: string) => lines.push(s) } as never,
      stderr: { write: () => undefined } as never,
      turns: 0,
      totalCostUsd: 0,
      registry: reg,
    });
    expect(lines.join("")).toMatch(/no schedules/);
  });
});

