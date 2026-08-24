import { useId, type JSX, type MouseEvent } from "react";

import type { EhuiDataSource, EhuiPanelId } from "@envoymesh/envoy-harness-client/ehui";

import { ehuiPanelLabel } from "./ehui-constants.js";
import { EhuiPanelContent } from "./EhuiPanelContent.js";

export interface EhuiPanelModalProps {
  panel: EhuiPanelId;
  dataSource: EhuiDataSource;
  refreshKey?: number;
  onClose: () => void;
  overlayClassName?: string;
  panelClassName?: string;
  closeButtonClassName?: string;
  actionButtonClassName?: string;
  primaryActionButtonClassName?: string;
  inputClassName?: string;
}

export function EhuiPanelModal(props: EhuiPanelModalProps): JSX.Element {
  const stop = (e: MouseEvent) => e.stopPropagation();
  // Unique per-instance id: two modals (chat + terminal) can be mounted
  // at once, and a hard-coded `aria-labelledby` would point at a
  // duplicated id.
  const titleId = useId();

  return (
    <div
      className={props.overlayClassName ?? "modal-overlay ehui-modal-overlay"}
      role="presentation"
      onClick={props.onClose}
    >
      <div
        className={props.panelClassName ?? "modal-panel ehui-modal-panel"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={stop}
      >
        <div className="modal-header ehui-modal-header">
          <h2 id={titleId}>{ehuiPanelLabel(props.panel)}</h2>
          <button
            type="button"
            className={props.closeButtonClassName ?? "modal-close"}
            onClick={props.onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <EhuiPanelContent
          panel={props.panel}
          dataSource={props.dataSource}
          {...(props.refreshKey !== undefined ? { refreshKey: props.refreshKey } : {})}
          {...(props.actionButtonClassName
            ? { actionButtonClassName: props.actionButtonClassName }
            : {})}
          {...(props.primaryActionButtonClassName
            ? { primaryActionButtonClassName: props.primaryActionButtonClassName }
            : {})}
          {...(props.inputClassName ? { inputClassName: props.inputClassName } : {})}
        />
      </div>
    </div>
  );
}
