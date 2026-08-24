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

export interface EhuiShellProps {
  dataSource: EhuiDataSource;
  activePanel?: EhuiPanelId;
  onPanelChange?: (panel: EhuiPanelId) => void;
  /** Bump to reload the active panel (e.g. after a chat turn completes). */
  refreshKey?: number;
  className?: string;
}

export function EhuiShell(props: EhuiShellProps): JSX.Element {
  const [panel, setPanel] = useState<EhuiPanelId>(
    props.activePanel ?? "plan",
  );
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
        {EHUI_COMMAND_PANEL_IDS.map((id) => {
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
      />
    </div>
  );
}

export { EHUI_PANELS } from "@envoymesh/envoy-harness-client/ehui";
