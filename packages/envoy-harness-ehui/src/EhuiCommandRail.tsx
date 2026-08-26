import { useEffect, useRef, useState, type JSX } from "react";

import type { EhuiPanelId } from "@envoymesh/envoy-harness-client/ehui";

import {
  EHUI_RAIL_MORE_PANEL_IDS,
  EHUI_RAIL_PRIMARY_PANEL_IDS,
  ehuiPanelLabel,
} from "./ehui-constants.js";

export interface EhuiCommandRailProps {
  onOpen: (panel: EhuiPanelId) => void;
  className?: string;
  linkClassName?: string;
  showSeparators?: boolean;
  separatorClassName?: string;
  moreLabel?: string;
}

export function EhuiCommandRail(props: EhuiCommandRailProps): JSX.Element {
  const linkClass = props.linkClassName ?? "ehui-command-link";
  const showSeparators = props.showSeparators ?? false;
  const sepClass = props.separatorClassName ?? "contact-web-content__sep";
  const moreLabel = props.moreLabel ?? "More";
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [moreOpen]);

  const openPanel = (panel: EhuiPanelId) => {
    setMoreOpen(false);
    props.onOpen(panel);
  };

  let linkIndex = 0;

  return (
    <nav
      className={props.className ?? "ehui-command-bar"}
      aria-label="EHUI panels"
    >
      {EHUI_RAIL_PRIMARY_PANEL_IDS.map((id) => {
        const index = linkIndex;
        linkIndex += 1;
        return (
          <span key={id} className="contact-web-content__link-item">
            {showSeparators && index > 0 ? (
              <span className={sepClass} aria-hidden="true">·</span>
            ) : null}
            <button
              type="button"
              className={linkClass}
              onClick={() => openPanel(id)}
            >
              {ehuiPanelLabel(id)}
            </button>
          </span>
        );
      })}
      {EHUI_RAIL_MORE_PANEL_IDS.length > 0 ? (
        <span className="contact-web-content__link-item ehui-more-menu-wrap">
          {showSeparators && linkIndex > 0 ? (
            <span className={sepClass} aria-hidden="true">·</span>
          ) : null}
          <div className="ehui-more-menu" ref={moreRef}>
            <button
              type="button"
              className={`${linkClass} ehui-more-trigger${moreOpen ? " ehui-more-trigger--open" : ""}`}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              onClick={() => setMoreOpen((open) => !open)}
            >
              {moreLabel}
            </button>
            {moreOpen ? (
              <div className="ehui-more-popover" role="menu">
                {EHUI_RAIL_MORE_PANEL_IDS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    className="ehui-more-item"
                    onClick={() => openPanel(id)}
                  >
                    {ehuiPanelLabel(id)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </span>
      ) : null}
    </nav>
  );
}
