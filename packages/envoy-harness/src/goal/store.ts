/**
 * Wave 4 — goal store + tools.
 */

export type GoalStatus = "active" | "paused" | "completed" | "blocked";

export interface Goal {
  id: string;
  title: string;
  detail?: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  rounds?: number;
}

export interface GoalStore {
  create(input: { title: string; detail?: string }): Goal;
  get(id: string): Goal | undefined;
  update(
    id: string,
    patch: Partial<{ title: string; detail: string; status: GoalStatus }>,
  ): Goal;
  list(): Goal[];
}

export function createGoalStore(): GoalStore {
  const goals = new Map<string, Goal>();
  let seq = 0;
  return {
    create(input) {
      const now = new Date().toISOString();
      const g: Goal = {
        id: `goal_${++seq}`,
        title: input.title,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        status: "active",
        createdAt: now,
        updatedAt: now,
        rounds: 0,
      };
      goals.set(g.id, g);
      return g;
    },
    get(id) {
      return goals.get(id);
    },
    update(id, patch) {
      const g = goals.get(id);
      if (g === undefined) throw new Error(`unknown goal '${id}'`);
      if (patch.title !== undefined) g.title = patch.title;
      if (patch.detail !== undefined) g.detail = patch.detail;
      if (patch.status !== undefined) g.status = patch.status;
      g.updatedAt = new Date().toISOString();
      return g;
    },
    list() {
      return [...goals.values()];
    },
  };
}
