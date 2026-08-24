import {
  EHUI_PANELS,
  type EhuiPanelId,
} from "@envoymesh/envoy-harness-client/ehui";

export const EHUI_COMMAND_PANEL_IDS: EhuiPanelId[] = EHUI_PANELS
  .map((p) => p.id)
  .filter((id) => id !== "chat");

export const PLAN_ACTIONS = ["show", "approve", "reject", "clear"] as const;
export const MEMORY_OPS = ["list", "read", "add"] as const;

export function ehuiPanelLabel(id: EhuiPanelId): string {
  const meta = EHUI_PANELS.find((p) => p.id === id);
  return meta?.label ?? id;
}
