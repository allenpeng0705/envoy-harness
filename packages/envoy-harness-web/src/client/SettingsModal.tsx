import { useEffect, useRef, useState, type JSX } from "react";
import type { EnterBehavior } from "./slash-catalog.js";

export type ThemeMode = "light" | "dark" | "system";

export type SettingsTab = "model" | "permissions" | "appearance";

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  providerDraft: string;
  modelDraft: string;
  baseUrlDraft: string;
  onProviderDraft: (v: string) => void;
  onModelDraft: (v: string) => void;
  onBaseUrlDraft: (v: string) => void;
  onApplyModel: () => void;
  sandbox: string;
  approval: string;
  autoRun: string;
  onPolicy: (partial: {
    sandbox?: string;
    approval?: string;
    autoRun?: string;
  }) => void;
  decisionMode: string;
  decisionBackend: string;
  decisionEndpointDraft: string;
  onDecisionEndpointDraft: (v: string) => void;
  onDecision: (partial: {
    mode?: string;
    backend?: string;
    endpoint?: string;
  }) => void;
  theme: ThemeMode;
  onTheme: (t: ThemeMode) => void;
  enterBehavior: EnterBehavior;
  onEnterBehavior: (v: EnterBehavior) => void;
  fontSizePx: number;
  onFontSizePx: (n: number) => void;
}

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "model", label: "Model" },
  { id: "permissions", label: "Permissions" },
  { id: "appearance", label: "Appearance" },
];

export function SettingsModal(props: SettingsModalProps): JSX.Element | null {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<SettingsTab>("model");

  useEffect(() => {
    if (!props.open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, props.onClose]);

  if (!props.open) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="modal settings-modal">
        <div className="modal-title-row">
          <h2 id="settings-title">Settings</h2>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            onClick={props.onClose}
            aria-label="Close settings"
          >
            ×
          </button>
        </div>

        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
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

        {tab === "model" ? (
          <div className="settings-pane" role="tabpanel">
            <label>
              Provider
              <input
                value={props.providerDraft}
                onChange={(e) => props.onProviderDraft(e.target.value)}
                placeholder="openai / anthropic / …"
              />
            </label>
            <label>
              Model
              <input
                value={props.modelDraft}
                onChange={(e) => props.onModelDraft(e.target.value)}
                placeholder="model id"
              />
            </label>
            <label>
              Base URL
              <input
                value={props.baseUrlDraft}
                onChange={(e) => props.onBaseUrlDraft(e.target.value)}
                placeholder="optional — OpenAI-/Anthropic-compatible endpoint"
              />
            </label>
            <button type="button" className="primary" onClick={props.onApplyModel}>
              Apply model
            </button>
            <p className="hint">
              API keys stay in the Node bridge / env — not browser storage. Base
              URL routes openai/anthropic providers to compatible gateways
              (LiteLLM, Azure, local proxies, …).
            </p>
          </div>
        ) : null}

        {tab === "permissions" ? (
          <div className="settings-pane" role="tabpanel">
            <label>
              Sandbox
              <select
                value={props.sandbox}
                onChange={(e) => props.onPolicy({ sandbox: e.target.value })}
              >
                <option value="read-only">read-only</option>
                <option value="workspace-write">workspace-write</option>
                <option value="danger-full-access">danger-full-access</option>
              </select>
            </label>
            <label>
              Approval
              <select
                value={props.approval}
                onChange={(e) => props.onPolicy({ approval: e.target.value })}
              >
                <option value="unless-trusted">unless-trusted</option>
                <option value="on-request">on-request</option>
                <option value="granular">granular</option>
                <option value="never">never</option>
              </select>
            </label>
            <label>
              Auto-run
              <select
                value={props.autoRun}
                onChange={(e) => props.onPolicy({ autoRun: e.target.value })}
              >
                <option value="always-confirm">always-confirm</option>
                <option value="safe-only">safe-only</option>
                <option value="off">off</option>
              </select>
            </label>

            <h3>Decision gate</h3>
            <p className="hint">
              Optional System One (Laya / Jev). Off by default. Keys stay in the
              Node bridge env — not browser storage.
            </p>
            <label>
              Mode
              <select
                value={props.decisionMode}
                onChange={(e) => props.onDecision({ mode: e.target.value })}
              >
                <option value="off">off</option>
                <option value="shadow">shadow</option>
                <option value="enforce">enforce</option>
              </select>
            </label>
            <label>
              Backend
              <select
                value={props.decisionBackend}
                disabled={props.decisionMode === "off"}
                onChange={(e) => props.onDecision({ backend: e.target.value })}
              >
                <option value="null">null</option>
                <option value="laya-http">laya-http</option>
                <option value="jev">jev</option>
                <option value="onnx">onnx</option>
              </select>
            </label>
            <label>
              Endpoint
              <input
                value={props.decisionEndpointDraft}
                disabled={props.decisionMode === "off"}
                onChange={(e) => props.onDecisionEndpointDraft(e.target.value)}
                placeholder="http://127.0.0.1:8000/v1/systemone"
              />
            </label>
            <button
              type="button"
              className="primary"
              disabled={props.decisionMode === "off"}
              onClick={() =>
                props.onDecision({
                  endpoint: props.decisionEndpointDraft.trim(),
                })
              }
            >
              Apply endpoint
            </button>
          </div>
        ) : null}

        {tab === "appearance" ? (
          <div className="settings-pane" role="tabpanel">
            <label>
              Theme
              <select
                value={props.theme}
                onChange={(e) => props.onTheme(e.target.value as ThemeMode)}
                aria-label="Color theme"
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <label>
              Enter key
              <select
                value={props.enterBehavior}
                onChange={(e) =>
                  props.onEnterBehavior(e.target.value as EnterBehavior)
                }
                aria-label="Enter key behavior"
              >
                <option value="enter-send">Enter sends</option>
                <option value="mod-enter-send">⌘/Ctrl+Enter sends</option>
              </select>
            </label>
            <label>
              Font size ({props.fontSizePx}px)
              <input
                type="range"
                min={12}
                max={22}
                step={1}
                value={props.fontSizePx}
                onChange={(e) => props.onFontSizePx(Number(e.target.value))}
                aria-label="UI font size"
              />
            </label>
          </div>
        ) : null}
      </div>
    </div>
  );
}
