import {
  EHUI_PANELS,
  type EhuiPanelId,
} from "@envoymesh/envoy-harness-client/ehui";

export const EHUI_COMMAND_PANEL_IDS: EhuiPanelId[] = EHUI_PANELS
  .map((p) => p.id)
  .filter((id) => id !== "chat");

/** Shown inline on the EH chat / terminal command bar. */
export const EHUI_RAIL_PRIMARY_PANEL_IDS: EhuiPanelId[] = [
  "plan",
  "git-diff",
  "memory",
];

export const EHUI_RAIL_MORE_PANEL_IDS: EhuiPanelId[] =
  EHUI_COMMAND_PANEL_IDS.filter(
    (id) => !EHUI_RAIL_PRIMARY_PANEL_IDS.includes(id),
  );

export const PLAN_ACTIONS = ["show", "approve", "reject", "clear"] as const;
export const MEMORY_OPS = ["list", "read", "add"] as const;

export const PLAN_ACTION_LABELS: Record<
  (typeof PLAN_ACTIONS)[number],
  string
> = {
  show: "Show",
  approve: "Approve",
  reject: "Reject",
  clear: "Clear",
};

export const MEMORY_OP_LABELS: Record<(typeof MEMORY_OPS)[number], string> = {
  list: "List",
  read: "Read",
  add: "Add",
};

export function ehuiPanelLabel(id: EhuiPanelId): string {
  const meta = EHUI_PANELS.find((p) => p.id === id);
  return meta?.label ?? id;
}
