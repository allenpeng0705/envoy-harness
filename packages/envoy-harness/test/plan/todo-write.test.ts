import { describe, expect, it, vi } from "vitest";

import { InMemorySession } from "../../src/session.js";
import { makeTodoWriteTool } from "../../src/plan/todo-write.js";
import { acpPlanUpdateParams } from "../../src/plan/items.js";

describe("todo_write", () => {
  it("replaces plan items and notifies listeners", async () => {
    const session = new InMemorySession("s1", {
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    });
    const onChange = vi.fn();
    const tool = makeTodoWriteTool({ onChange });
    const result = await tool.execute(
      {
        todos: [
          { id: "a", content: "Fix suite", status: "in_progress", priority: "high" },
          { content: "Ship", status: "pending" },
        ],
      },
      { session, cwd: "/tmp", abortSignal: new AbortController().signal },
    );
    expect(result.isError).toBeUndefined();
    expect(session.getPlanItems()).toEqual([
      { id: "a", content: "Fix suite", status: "in_progress", priority: "high" },
      { id: "todo-2", content: "Ship", status: "pending" },
    ]);
    expect(onChange).toHaveBeenCalledWith("s1", session.getPlanItems());
    const update = acpPlanUpdateParams("s1", session.getPlanItems()).update;
    expect(update.sessionUpdate).toBe("plan_update");
    expect(update.plan.entries).toEqual([
      { id: "a", content: "Fix suite", status: "in_progress", priority: "high" },
      { id: "todo-2", content: "Ship", status: "pending" },
    ]);
  });

  it("clears the checklist", async () => {
    const session = new InMemorySession("s1", {
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    });
    session.setPlanItems([{ id: "a", content: "X", status: "pending" }]);
    const tool = makeTodoWriteTool({});
    await tool.execute({ todos: [] }, {
      session,
      cwd: "/tmp",
      abortSignal: new AbortController().signal,
    });
    expect(session.getPlanItems()).toEqual([]);
    expect(acpPlanUpdateParams("s1", []).update.sessionUpdate).toBe("plan_removed");
  });
});
