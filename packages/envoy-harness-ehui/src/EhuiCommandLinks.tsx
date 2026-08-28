import type { JSX } from "react";

import type { EhuiPanelId } from "@envoymesh/envoy-harness-client/ehui";

import { EHUI_COMMAND_PANEL_IDS, ehuiPanelLabel } from "./ehui-constants.js";

export interface EhuiCommandLinksProps {
  onOpen: (panel: EhuiPanelId) => void;
  className?: string;
  linkClassName?: string;
  /** Middle dot between links (matches Profile · Blog row). */
  showSeparators?: boolean;
  separatorClassName?: string;
}

export function EhuiCommandLinks(props: EhuiCommandLinksProps): JSX.Element {
  const linkClass = props.linkClassName ?? "ehui-command-link";
  const showSeparators = props.showSeparators ?? false;
  const sepClass = props.separatorClassName ?? "contact-web-content__sep";

  return (
    <nav className={props.className ?? "ehui-command-bar"} aria-label="EHUI panels">
      {EHUI_COMMAND_PANEL_IDS.map((id, index) => (
        <span key={id} className="contact-web-content__link-item">
          {showSeparators && index > 0 ? (
            <span className={sepClass} aria-hidden="true">·</span>
          ) : null}
          <button
            type="button"
            className={linkClass}
            onClick={() => props.onOpen(id)}
          >
            {ehuiPanelLabel(id)}
          </button>
        </span>
      ))}
    </nav>
  );
}
