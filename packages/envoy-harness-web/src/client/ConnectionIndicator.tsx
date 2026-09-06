import { useEffect, useState, type JSX } from "react";
import type { ConnectionState } from "./acp/host.js";

export interface ConnectionIndicatorProps {
  state: ConnectionState;
  retryAttempt: number;
  onReconnect: () => void;
}

/**
 * dsh-inspired connection control: idle/healthy shows Connected briefly
 * then compact; yellow states offer Reconnect now on hover.
 */
export function ConnectionIndicator(
  props: ConnectionIndicatorProps,
): JSX.Element | null {
  const { state, retryAttempt, onReconnect } = props;
  const [hover, setHover] = useState(false);
  const [showOkFlash, setShowOkFlash] = useState(false);

  useEffect(() => {
    if (state !== "connected") {
      setShowOkFlash(false);
      return;
    }
    setShowOkFlash(true);
    const t = setTimeout(() => setShowOkFlash(false), 2000);
    return () => clearTimeout(t);
  }, [state]);

  if (state === "idle") return null;
  if (state === "connected" && !showOkFlash) {
    return (
      <span className="conn-pill conn-ok" title="Connected">
        Connected
      </span>
    );
  }

  if (state === "connected" && showOkFlash) {
    return <span className="conn-pill conn-ok">Connected</span>;
  }

  const label =
    hover
      ? "Reconnect now"
      : state === "connecting"
        ? retryAttempt > 0
          ? `Connecting… #${retryAttempt}`
          : "Connecting…"
        : "Disconnected";

  return (
    <button
      type="button"
      className={`conn-pill conn-warn ${state === "connecting" ? "conn-pulse" : ""}`}
      onClick={() => onReconnect()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      {label}
    </button>
  );
}
