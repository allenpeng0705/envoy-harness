/**
 * Wave 3/4 REPL slash commands: `/schedule`, `/goals`.
 */

import type { ReplCommand } from "./types.js";

function formatRecurrence(task: {
  recurrence:
    | { kind: "once"; at: string }
    | { kind: "interval"; everyMs: number; nextAt: string };
  enabled: boolean;
  lastFiredAt?: string;
}): string {
  const r = task.recurrence;
  const when =
    r.kind === "once"
      ? `once@${r.at}`
      : `every ${r.everyMs}ms next@${r.nextAt}`;
  const fired = task.lastFiredAt ? ` last=${task.lastFiredAt}` : "";
  return `${when} enabled=${task.enabled}${fired}`;
}

const scheduleCommand: ReplCommand = {
  name: "/schedule",
  description:
    "schedules. Subcommands: list | create <prompt> [--at <iso>|--every-ms <n>] | tick",
  async handler(args, ctx) {
    const sub = args[0] ?? "list";
    switch (sub) {
      case "list": {
        if (!ctx.agent.tools.has("schedule_list")) {
          ctx.stderr.write(
            "schedule not enabled (try --schedule, --power, or remove --no-schedule in REPL)\n",
          );
          return;
        }
        const list = ctx.agent.listSchedules();
        if (list.length === 0) {
          ctx.stdout.write("(no schedules)\n");
          return;
        }
        for (const t of list) {
          ctx.stdout.write(
            `- ${t.id}: ${formatRecurrence(t)} — ${t.prompt.slice(0, 80)}\n`,
          );
        }
        return;
      }
      case "create": {
        const rest = args.slice(1);
        let runAt: string | undefined;
        let everyMs: number | undefined;
        const promptParts: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          const a = rest[i]!;
          if (a === "--at") {
            runAt = rest[++i];
            continue;
          }
          if (a === "--every-ms") {
            const n = Number(rest[++i]);
            if (!Number.isFinite(n) || n <= 0) {
              ctx.stderr.write("usage: --every-ms <positive number>\n");
              return;
            }
            everyMs = n;
            continue;
          }
          promptParts.push(a);
        }
        const prompt = promptParts.join(" ").trim();
        if (prompt.length === 0) {
          ctx.stderr.write(
            "usage: /schedule create <prompt> [--at <iso>] [--every-ms <n>]\n",
          );
          return;
        }
        try {
          const task = ctx.agent.createSchedule({
            prompt,
            ...(runAt !== undefined ? { runAt } : {}),
            ...(everyMs !== undefined ? { everyMs } : {}),
          });
          ctx.stdout.write(`created ${task.id}\n`);
        } catch (err) {
          ctx.stderr.write(`${(err as Error).message}\n`);
        }
        return;
      }
      case "tick": {
        const n = ctx.agent.tickSchedules();
        ctx.stdout.write(`fired ${n} due schedule(s)\n`);
        return;
      }
      default:
        ctx.stderr.write(
          `unknown /schedule subcommand: ${sub} (try: list, create, tick)\n`,
        );
    }
  },
};

const goalsCommand: ReplCommand = {
  name: "/goals",
  description: "goals. Subcommands: list | create <title> [--detail <text>]",
  async handler(args, ctx) {
    const sub = args[0] ?? "list";
    switch (sub) {
      case "list": {
        if (!ctx.agent.tools.has("create_goal")) {
          ctx.stderr.write(
            "goals not enabled (try --goals, --power, or remove --no-goals in REPL)\n",
          );
          return;
        }
        const list = ctx.agent.listGoals();
        if (list.length === 0) {
          ctx.stdout.write("(no goals)\n");
          return;
        }
        for (const g of list) {
          const detail = g.detail ? ` — ${g.detail.slice(0, 60)}` : "";
          ctx.stdout.write(`- ${g.id} [${g.status}] ${g.title}${detail}\n`);
        }
        return;
      }
      case "create": {
        const rest = args.slice(1);
        let detail: string | undefined;
        const titleParts: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          const a = rest[i]!;
          if (a === "--detail") {
            detail = rest.slice(++i).join(" ");
            break;
          }
          titleParts.push(a);
        }
        const title = titleParts.join(" ").trim();
        if (title.length === 0) {
          ctx.stderr.write(
            "usage: /goals create <title> [--detail <text>]\n",
          );
          return;
        }
        try {
          const g = ctx.agent.createGoal({
            title,
            ...(detail !== undefined && detail.length > 0 ? { detail } : {}),
          });
          ctx.stdout.write(`created ${g.id}\n`);
        } catch (err) {
          ctx.stderr.write(`${(err as Error).message}\n`);
        }
        return;
      }
      default:
        ctx.stderr.write(
          `unknown /goals subcommand: ${sub} (try: list, create)\n`,
        );
    }
  },
};

const pluginsCommand: ReplCommand = {
  name: "/plugins",
  description: "list plugins. Subcommands: list",
  async handler(args, ctx) {
    const sub = args[0] ?? "list";
    if (sub !== "list") {
      ctx.stderr.write(
        `unknown /plugins subcommand: ${sub} (try: list)\n`,
      );
      return;
    }
    const registry = ctx.agent.plugins;
    if (registry === undefined) {
      ctx.stdout.write(
        "(no plugin registry on this agent; use --plugin / config plugins.allow)\n",
      );
      return;
    }
    const listed = registry.list();
    if (listed.length === 0) {
      ctx.stdout.write("(no plugins loaded)\n");
      return;
    }
    for (const name of listed) {
      ctx.stdout.write(`- ${name}\n`);
    }
  },
};

export const BUILTIN_TIER2_BATCH5_COMMANDS: ReadonlyArray<ReplCommand> = [
  scheduleCommand,
  goalsCommand,
  pluginsCommand,
];
