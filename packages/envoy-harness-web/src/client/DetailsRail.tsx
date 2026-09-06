import { useState, type JSX } from "react";
import { EhuiShell } from "@envoymesh/envoy-harness-ehui";
import type { EhuiDataSource, EhuiPanelId } from "@envoymesh/envoy-harness-client/ehui";
import type { MeshSnapshot } from "./acp/host.js";
import { MeshRail } from "./MeshRail.js";

/** Mesh lives in MeshRail; EHUI keeps workspace/ops panels. */
export const DETAILS_EHUI_PANELS: readonly EhuiPanelId[] = [
  "plan",
  "memory",
  "git-diff",
  "git-status",
  "team",
  "scoreboard",
  "trace",
  "resume",
];

export type DetailsTab = "mesh" | "tools";

export interface DetailsRailProps {
  mesh: MeshSnapshot | null;
  onRefreshMesh: () => void;
  ehuiSource: EhuiDataSource | null;
  ehuiRefresh: number;
  onResumeSession: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function DetailsRail(props: DetailsRailProps): JSX.Element {
  const [tab, setTab] = useState<DetailsTab>("mesh");

  return (
    <aside
      className={`details-rail${props.collapsed ? " collapsed" : ""}`}
      aria-label="Details"
    >
      <div className="details-head">
        {!props.collapsed ? (
          <div className="details-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "mesh"}
              className={tab === "mesh" ? "active" : ""}
              onClick={() => setTab("mesh")}
            >
              Mesh
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "tools"}
              className={tab === "tools" ? "active" : ""}
              onClick={() => setTab("tools")}
            >
              Tools
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className="icon-btn"
          title={props.collapsed ? "Expand details" : "Collapse details"}
          onClick={props.onToggleCollapsed}
        >
          {props.collapsed ? "«" : "»"}
        </button>
      </div>

      {!props.collapsed ? (
        <div className="details-body">
          {tab === "mesh" ? (
            <MeshRail mesh={props.mesh} onRefresh={props.onRefreshMesh} />
          ) : props.ehuiSource ? (
            <div className="ehui-dock">
              <EhuiShell
                dataSource={props.ehuiSource}
                refreshKey={props.ehuiRefresh}
                panelIds={DETAILS_EHUI_PANELS}
                onResumeSession={props.onResumeSession}
              />
            </div>
          ) : (
            <p className="muted side-placeholder">
              Tools wait for a live session…
            </p>
          )}
        </div>
      ) : null}
    </aside>
  );
}
