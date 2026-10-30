/**
 * ACP-style plan checklist items (Cursor TodoWrite / Codex todo pattern).
 *
 * Orthogonal to markdown {@link PlanState}: that is the draft→approve document;
 * these entries are the live execution tracker pushed as `session/update`
 * `plan_update` to clients such as EnvoyDev.
 */

export type PlanItemStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export type PlanItemPriority = "high" | "medium" | "low";

export interface PlanItem {
  /** Stable id for merge across tool calls. */
  id: string;
  content: string;
  status: PlanItemStatus;
  priority?: PlanItemPriority;
}

/** Map to ACP plan entry shape (include stable `id` for client list reconciliation). */
export function planItemsToAcpEntries(
  items: readonly PlanItem[],
): ReadonlyArray<{
  id: string;
  content: string;
  status: PlanItemStatus;
  priority?: PlanItemPriority;
}> {
  return items.map((item) => ({
    id: item.id,
    content: item.content,
    status: item.status,
    ...(item.priority !== undefined ? { priority: item.priority } : {}),
  }));
}

export function acpPlanUpdateParams(
  sessionId: string,
  items: readonly PlanItem[],
): {
  sessionId: string;
  update: {
    sessionUpdate: "plan_update" | "plan_removed";
    plan: {
      type: "items";
      planId: string;
      entries: ReturnType<typeof planItemsToAcpEntries>;
    };
  };
} {
  if (items.length === 0) {
    return {
      sessionId,
      update: {
        sessionUpdate: "plan_removed",
        plan: { type: "items", planId: sessionId, entries: [] },
      },
    };
  }
  return {
    sessionId,
    update: {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: sessionId,
        entries: planItemsToAcpEntries(items),
      },
    },
  };
}
