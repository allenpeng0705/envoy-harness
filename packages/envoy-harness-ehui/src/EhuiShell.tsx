/**
 * EHUI React shell — tab strip + panel bodies for EnvoyGo / EnvoyMesh.
 */

import { useCallback, useEffect, useState, type JSX } from "react";

import {
  EHUI_PANELS,
  type EhuiDataSource,
  type EhuiPanelId,
} from "@envoymesh/envoy-harness-client/ehui";

import { EHUI_COMMAND_PANEL_IDS } from "./ehui-constants.js";
import { EhuiPanelContent } from "./EhuiPanelContent.js";

export type { EhuiPanelId };

export { EHUI_COMMAND_PANEL_IDS } from "./ehui-constants.js";

export interface EhuiShellProps {
  dataSource: EhuiDataSource;
  activePanel?: EhuiPanelId;
  onPanelChange?: (panel: EhuiPanelId) => void;
  /** Bump to reload the active panel (e.g. after a chat turn completes). */
  refreshKey?: number;
  className?: string;
  /** Host loads the selected persisted session (Resume panel). */
  onResumeSession?: (sessionId: string) => void;
  /** Override which panels appear in the tab strip (defaults to all non-chat). */
  panelIds?: readonly EhuiPanelId[];
}

export function EhuiShell(props: EhuiShellProps): JSX.Element {
  const panelIds = props.panelIds ?? EHUI_COMMAND_PANEL_IDS;
  const defaultPanel = props.activePanel ?? panelIds[0] ?? "plan";
  const [panel, setPanel] = useState<EhuiPanelId>(defaultPanel);
  const [clusterLine, setClusterLine] = useState<string>("");

  const select = useCallback(
    (id: EhuiPanelId) => {
      setPanel(id);
      props.onPanelChange?.(id);
    },
    [props.onPanelChange],
  );

  useEffect(() => {
    if (props.activePanel !== undefined && props.activePanel !== panel) {
      setPanel(props.activePanel);
    }
  }, [props.activePanel, panel]);

  useEffect(() => {
    if (!panelIds.includes(panel) && panelIds[0] !== undefined) {
      setPanel(panelIds[0]);
    }
  }, [panel, panelIds]);

  useEffect(() => {
    void props.dataSource.clusterStatus().then((c) => {
      setClusterLine(`mesh ${c.connected}/${c.peers.length} peers`);
    }).catch(() => {
      setClusterLine("");
    });
  }, [props.dataSource, props.refreshKey]);

  return (
    <div className={props.className} data-ehui-shell>
      {clusterLine ? (
        <div className="ehui-rail-meta">{clusterLine}</div>
      ) : null}
      <nav className="ehui-tabs" aria-label="EHUI panels">
        {panelIds.map((id) => {
          const meta = EHUI_PANELS.find((p) => p.id === id);
          const label = meta?.label ?? id;
          return (
            <button
              key={id}
              type="button"
              className="ehui-tab"
              onClick={() => select(id)}
              aria-pressed={panel === id}
            >
              {label}
            </button>
          );
        })}
      </nav>
      <EhuiPanelContent
        panel={panel}
        dataSource={props.dataSource}
        {...(props.refreshKey !== undefined ? { refreshKey: props.refreshKey } : {})}
        {...(props.onResumeSession !== undefined
          ? { onResumeSession: props.onResumeSession }
          : {})}
      />
    </div>
  );
}

export { EHUI_PANELS } from "@envoymesh/envoy-harness-client/ehui";
