import { useEffect, useRef, type JSX } from "react";

export type ThemeMode = "light" | "dark";

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  providerDraft: string;
  modelDraft: string;
  onProviderDraft: (v: string) => void;
  onModelDraft: (v: string) => void;
  onApplyModel: () => void;
  sandbox: string;
  approval: string;
  autoRun: string;
  onPolicy: (partial: {
    sandbox?: string;
    approval?: string;
    autoRun?: string;
  }) => void;
  theme: ThemeMode;
  onTheme: (t: ThemeMode) => void;
}

export function SettingsModal(props: SettingsModalProps): JSX.Element | null {
  const closeRef = useRef<HTMLButtonElement>(null);

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

        <h3>Appearance</h3>
        <label>
          Theme
          <select
            value={props.theme}
            onChange={(e) => props.onTheme(e.target.value as ThemeMode)}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>

        <h3>Model & policy</h3>
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
        <button type="button" className="primary" onClick={props.onApplyModel}>
          Apply model
        </button>
        <p className="hint">
          API keys stay in the Node bridge / env — not browser storage.
        </p>
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
      </div>
    </div>
  );
}
