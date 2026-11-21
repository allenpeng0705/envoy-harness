import { useEffect, useRef, useState, type JSX } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AcpHost } from "./acp/host.js";

/**
 * Interactive ACP terminal (Wave 3) via xterm.js.
 * Falls back to the status log when no PTY session is open.
 */

export interface TerminalPanelProps {
  host: AcpHost;
  ready: boolean;
  cwd: string;
  lines: ReadonlyArray<string>;
  onClear?: () => void;
}

export function TerminalPanel(props: TerminalPanelProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const inputBuf = useRef("");

  useEffect(() => {
    if (!containerRef.current || termRef.current) return;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      theme: {
        background: "#111",
        foreground: "#e8e8e8",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const onResize = (): void => {
      try {
        fit.fit();
      } catch {
        // ignore
      }
    };
    window.addEventListener("resize", onResize);

    term.onData((data) => {
      const id = terminalIdRef.current;
      if (!id || !props.ready) return;
      // Line-buffered for ACP write (submit on Enter).
      if (data === "\r" || data === "\n") {
        const line = inputBuf.current;
        inputBuf.current = "";
        void props.host
          .writeTerminal(id, line, true)
          .catch((err) => {
            setError(err instanceof Error ? err.message : String(err));
          });
        return;
      }
      if (data === "\u007f") {
        inputBuf.current = inputBuf.current.slice(0, -1);
        return;
      }
      inputBuf.current += data;
      void props.host.writeTerminal(id, data, false).catch(() => undefined);
    });

    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [props.host, props.ready]);

  useEffect(() => {
    return props.host.subscribeTerminalOutput((ev) => {
      if (ev.terminalId !== terminalIdRef.current) return;
      termRef.current?.write(ev.data);
    });
  }, [props.host]);

  const start = async (): Promise<void> => {
    setError(null);
    try {
      if (terminalIdRef.current) {
        await props.host.closeTerminal(terminalIdRef.current).catch(() => undefined);
        terminalIdRef.current = null;
      }
      const res = await props.host.openTerminal({
        ...(props.cwd ? { cwd: props.cwd } : {}),
        name: "web",
      });
      terminalIdRef.current = res.terminalId;
      setActive(true);
      termRef.current?.reset();
      if (res.motd) termRef.current?.writeln(res.motd);
      fitRef.current?.fit();
      termRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActive(false);
    }
  };

  const stop = async (): Promise<void> => {
    const id = terminalIdRef.current;
    terminalIdRef.current = null;
    setActive(false);
    if (id) {
      await props.host.closeTerminal(id).catch(() => undefined);
    }
  };

  return (
    <div className="terminal-panel">
      <div className="terminal-toolbar">
        <span className="muted">
          {active ? "Interactive PTY" : "Tool output log"}
        </span>
        <div className="terminal-actions">
          {props.ready ? (
            active ? (
              <button type="button" onClick={() => void stop()}>
                Stop
              </button>
            ) : (
              <button type="button" onClick={() => void start()}>
                Start PTY
              </button>
            )
          ) : null}
          {!active && props.onClear ? (
            <button type="button" onClick={props.onClear}>
              Clear
            </button>
          ) : null}
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div
        ref={containerRef}
        className="terminal-xterm"
        style={{ display: active ? "block" : "none" }}
      />
      {!active ? (
        props.lines.length === 0 ? (
          <p className="muted side-placeholder">
            Start a PTY for an interactive shell, or watch tool/bash status
            lines here.
          </p>
        ) : (
          <pre className="terminal-body mono">{props.lines.join("\n")}</pre>
        )
      ) : null}
    </div>
  );
}
