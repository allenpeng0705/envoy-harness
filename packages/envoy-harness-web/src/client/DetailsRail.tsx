import { useEffect, useState, type JSX } from "react";
import { EhuiShell } from "@envoymesh/envoy-harness-ehui";
import type { EhuiDataSource, EhuiPanelId } from "@envoymesh/envoy-harness-client/ehui";
import type {
  AcpHost,
  AgentInterruptResult,
  AgentMessageResult,
  MeshSnapshot,
} from "./acp/host.js";
import { MeshRail } from "./MeshRail.js";
import { FileTreePanel, type FsNode } from "./FileTreePanel.js";
import { PreviewPanel } from "./PreviewPanel.js";
import { TerminalPanel } from "./TerminalPanel.js";
import { SchedulePanel } from "./SchedulePanel.js";
import { GoalsPanel } from "./GoalsPanel.js";
import { basenameLabel } from "./composer-docks.js";

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

export type DetailsTab =
  | "mesh"
  | "tools"
  | "files"
  | "preview"
  | "terminal"
  | "schedule"
  | "goals";

/** Wave 6 — jump from Changes dock into Details. */
export interface DetailsFocusRequest {
  seq: number;
  tab: DetailsTab;
  ehuiPanel?: EhuiPanelId;
  previewPath?: string;
}

export interface DetailsRailProps {
  mesh: MeshSnapshot | null;
  onRefreshMesh: () => void;
  onSendAgentMessage?: (
    agentId: string,
    message: string,
  ) => Promise<AgentMessageResult>;
  onInterruptAgent?: (
    agentId: string,
  ) => Promise<AgentInterruptResult>;
  ehuiSource: EhuiDataSource | null;
  ehuiRefresh: number;
  onResumeSession: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Wave 2 FS + panes */
  sessionReady: boolean;
  listFs: (path?: string) => Promise<FsNode[]>;
  readFs: (
    path: string,
  ) => Promise<{
    path: string;
    text?: string;
    truncated?: boolean;
    mime?: string;
    binary?: boolean;
  }>;
  onAttachPath?: (path: string) => void;
  terminalLines: ReadonlyArray<string>;
  onClearTerminal?: () => void;
  host: AcpHost;
  cwd: string;
  /** Wave 6 — open a tab / EHUI panel / preview path when `seq` bumps. */
  focusRequest?: DetailsFocusRequest | null;
}

const TABS: Array<{ id: DetailsTab; label: string }> = [
  { id: "mesh", label: "Mesh" },
  { id: "tools", label: "Tools" },
  { id: "files", label: "Files" },
  { id: "preview", label: "Preview" },
  { id: "terminal", label: "Terminal" },
  { id: "schedule", label: "Schedule" },
  { id: "goals", label: "Goals" },
];

export function DetailsRail(props: DetailsRailProps): JSX.Element {
  const [tab, setTab] = useState<DetailsTab>("mesh");
  const [previewFile, setPreviewFile] = useState<FsNode | null>(null);
  const [ehuiPanel, setEhuiPanel] = useState<EhuiPanelId>("git-diff");

  useEffect(() => {
    const req = props.focusRequest;
    if (req == null) return;
    setTab(req.tab);
    if (req.ehuiPanel !== undefined) {
      setEhuiPanel(req.ehuiPanel);
    }
    if (req.previewPath !== undefined && req.previewPath.length > 0) {
      setPreviewFile({
        name: basenameLabel(req.previewPath),
        path: req.previewPath,
        kind: "file",
      });
    }
  }, [props.focusRequest]);

  return (
    <aside
      className={`details-rail${props.collapsed ? " collapsed" : ""}`}
      aria-label="Details"
    >
      <div className="details-head">
        {!props.collapsed ? (
          <div className="details-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? "active" : ""}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
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
            <MeshRail
              mesh={props.mesh}
              onRefresh={props.onRefreshMesh}
              {...(props.onSendAgentMessage !== undefined
                ? { onSendAgentMessage: props.onSendAgentMessage }
                : {})}
              {...(props.onInterruptAgent !== undefined
                ? { onInterruptAgent: props.onInterruptAgent }
                : {})}
            />
          ) : null}
          {tab === "tools" ? (
            props.ehuiSource ? (
              <div className="ehui-dock">
                <EhuiShell
                  dataSource={props.ehuiSource}
                  refreshKey={props.ehuiRefresh}
                  panelIds={DETAILS_EHUI_PANELS}
                  activePanel={ehuiPanel}
                  onPanelChange={setEhuiPanel}
                  onResumeSession={props.onResumeSession}
                />
              </div>
            ) : (
              <p className="muted side-placeholder">
                Tools wait for a live session…
              </p>
            )
          ) : null}
          {tab === "files" ? (
            <FileTreePanel
              ready={props.sessionReady}
              listFs={props.listFs}
              onOpenFile={(entry) => {
                setPreviewFile(entry);
                setTab("preview");
              }}
            />
          ) : null}
          {tab === "preview" ? (
            <PreviewPanel
              file={previewFile}
              readFs={props.readFs}
              {...(props.onAttachPath !== undefined
                ? { onAttachPath: props.onAttachPath }
                : {})}
            />
          ) : null}
          {tab === "terminal" ? (
            <TerminalPanel
              host={props.host}
              ready={props.sessionReady}
              cwd={props.cwd}
              lines={props.terminalLines}
              {...(props.onClearTerminal !== undefined
                ? { onClear: props.onClearTerminal }
                : {})}
            />
          ) : null}
          {tab === "schedule" ? (
            <SchedulePanel
              ready={props.sessionReady}
              list={() => props.host.listSchedules()}
              create={(input) => props.host.createSchedule(input)}
              tick={() => props.host.tickSchedules()}
            />
          ) : null}
          {tab === "goals" ? (
            <GoalsPanel
              ready={props.sessionReady}
              list={() => props.host.listGoals()}
              create={(input) => props.host.createGoal(input)}
            />
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
