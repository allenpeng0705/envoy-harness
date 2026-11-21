/**
 * Wave 3 — in-process schedule store (cron-lite → inbox inject).
 */

export type ScheduleRecurrence =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number; nextAt: string };

export interface ScheduleTask {
  id: string;
  prompt: string;
  recurrence: ScheduleRecurrence;
  enabled: boolean;
  createdAt: string;
  lastFiredAt?: string;
}

export interface ScheduleStore {
  create(input: {
    prompt: string;
    runAt?: string;
    everyMs?: number;
  }): ScheduleTask;
  edit(
    id: string,
    patch: Partial<{ prompt: string; enabled: boolean; everyMs: number; runAt: string }>,
  ): ScheduleTask;
  list(): ScheduleTask[];
  view(id: string): ScheduleTask | undefined;
  /** Due tasks at `now`; advances interval schedules. */
  claimDue(now?: Date): ScheduleTask[];
}

export function createScheduleStore(): ScheduleStore {
  const tasks = new Map<string, ScheduleTask>();
  let seq = 0;

  return {
    create(input) {
      const id = `sched_${++seq}`;
      const now = new Date().toISOString();
      let recurrence: ScheduleRecurrence;
      if (input.everyMs !== undefined && input.everyMs > 0) {
        recurrence = {
          kind: "interval",
          everyMs: input.everyMs,
          nextAt: input.runAt ?? now,
        };
      } else {
        recurrence = {
          kind: "once",
          at: input.runAt ?? now,
        };
      }
      const task: ScheduleTask = {
        id,
        prompt: input.prompt,
        recurrence,
        enabled: true,
        createdAt: now,
      };
      tasks.set(id, task);
      return task;
    },
    edit(id, patch) {
      const task = tasks.get(id);
      if (task === undefined) throw new Error(`unknown schedule '${id}'`);
      if (patch.prompt !== undefined) task.prompt = patch.prompt;
      if (patch.enabled !== undefined) task.enabled = patch.enabled;
      if (patch.everyMs !== undefined && task.recurrence.kind === "interval") {
        task.recurrence = {
          ...task.recurrence,
          everyMs: patch.everyMs,
        };
      }
      if (patch.runAt !== undefined) {
        if (task.recurrence.kind === "once") {
          task.recurrence = { kind: "once", at: patch.runAt };
        } else {
          task.recurrence = { ...task.recurrence, nextAt: patch.runAt };
        }
      }
      return task;
    },
    list() {
      return [...tasks.values()];
    },
    view(id) {
      return tasks.get(id);
    },
    claimDue(now = new Date()) {
      const due: ScheduleTask[] = [];
      const iso = now.toISOString();
      for (const task of tasks.values()) {
        if (!task.enabled) continue;
        if (task.recurrence.kind === "once") {
          if (task.recurrence.at <= iso && task.lastFiredAt === undefined) {
            task.lastFiredAt = iso;
            task.enabled = false;
            due.push({ ...task });
          }
        } else if (task.recurrence.nextAt <= iso) {
          task.lastFiredAt = iso;
          const next = new Date(
            now.getTime() + task.recurrence.everyMs,
          ).toISOString();
          task.recurrence = { ...task.recurrence, nextAt: next };
          due.push({ ...task });
        }
      }
      return due;
    },
  };
}
